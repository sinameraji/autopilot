import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import chalk from "chalk";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string, display?: string) => void;
  onHistoryUp?: () => void;
  onHistoryDown?: () => void;
  onClearQueueItem?: (text: string) => void;
  focus?: boolean;
  mask?: string;
  enablePaste?: boolean;
  cursorOffset?: number;
  onCursorChange?: (offset: number) => void;
  pickerActive?: boolean;
  onPickerUp?: () => void;
  onPickerDown?: () => void;
  onPickerSelect?: () => void;
  onPickerCancel?: () => void;
  onCancel?: () => void;
  width?: number;
}

const PASTE_CHAR_THRESHOLD = 200;
const PASTE_NEWLINE_THRESHOLD = 1;

export function shouldTreatAsPaste(input: string): boolean {
  if (input.length >= PASTE_CHAR_THRESHOLD) return true;
  const newlines = (input.match(/\n/g) ?? []).length;
  return newlines >= PASTE_NEWLINE_THRESHOLD;
}

export function makePastePreview(input: string, lines: number, id: number): string {
  const firstLine = input.split("\n")[0] ?? "";
  const cleaned = firstLine.trim().replace(/\s+/g, " ");
  const preview = cleaned.length > 20 ? cleaned.slice(0, 20) + "…" : cleaned;
  const text = preview || "(empty)";
  return `⦗"${text}" (${lines} line${lines === 1 ? "" : "s"}) #${id}⦘`;
}

export function countLines(s: string): number {
  return s.split("\n").length;
}

/** Strip control characters and ANSI escapes that corrupt terminal state. */
export function sanitizeInput(input: string): string {
  return (
    input
      // Normalize Windows line endings
      .replace(/\r\n/g, "\n")
      // Lone CR → LF so it behaves like a newline in text input
      .replace(/\r/g, "\n")
      // Strip ANSI escape sequences (CSI and single-byte)
      .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
      // Tabs are one char in the string but multi-column in the terminal;
      // replace with two spaces to keep cursor alignment predictable.
      .replace(/\t/g, "  ")
  );
}

export function findWordBoundaryForward(text: string, pos: number): number {
  while (pos < text.length && /\w/.test(text[pos]!)) pos++;
  while (pos < text.length && !/\w/.test(text[pos]!)) pos++;
  return pos;
}

export function findWordBoundaryBackward(text: string, pos: number): number {
  while (pos > 0 && !/\w/.test(text[pos - 1]!)) pos--;
  while (pos > 0 && /\w/.test(text[pos - 1]!)) pos--;
  return pos;
}

export function CustomTextInput({
  value,
  onChange,
  onSubmit,
  onHistoryUp,
  onHistoryDown,
  onClearQueueItem,
  focus = true,
  mask,
  enablePaste = false,
  cursorOffset: controlledCursor,
  onCursorChange,
  pickerActive = false,
  onPickerUp,
  onPickerDown,
  onPickerSelect,
  onPickerCancel,
  onCancel,
  width,
}: Props) {
  const [internalCursor, setInternalCursor] = useState(value.length);
  const cursorOffset = controlledCursor ?? internalCursor;
  const setCursorOffset = (offset: number) => {
    setInternalCursor(offset);
    onCursorChange?.(offset);
  };
  const pastesRef = useRef<Map<string, string>>(new Map());
  const pasteCounterRef = useRef(0);
  const prevValueRef = useRef(value);
  const cursorOffsetRef = useRef(cursorOffset);

  // Keep ref in sync without adding cursorOffset to effect deps.
  cursorOffsetRef.current = cursorOffset;

  useEffect(() => {
    if (!focus) return;
    const prevValue = prevValueRef.current;
    prevValueRef.current = value;

    if (value === prevValue) return;

    const currentCursor = cursorOffsetRef.current;

    // If the cursor was at the end of the previous value, keep it at the end
    // (handles history navigation and other external value replacements).
    if (currentCursor === prevValue.length) {
      if (currentCursor !== value.length) {
        setCursorOffset(value.length);
      }
      return;
    }

    // Otherwise just clamp to valid range.
    const next = currentCursor > value.length ? value.length : currentCursor;
    if (next !== currentCursor) {
      setCursorOffset(next);
    }
  }, [value, focus]);

  const handleInsert = (rawInput: string) => {
    let toInsert = sanitizeInput(rawInput);
    if (enablePaste && shouldTreatAsPaste(toInsert)) {
      const lines = countLines(toInsert);
      const id = ++pasteCounterRef.current;
      const placeholder = makePastePreview(toInsert, lines, id);
      pastesRef.current.set(placeholder, toInsert);
      toInsert = placeholder;
    }
    const nextValue = value.slice(0, cursorOffset) + toInsert + value.slice(cursorOffset);
    const nextCursor = cursorOffset + toInsert.length;
    if (nextCursor !== cursorOffset) {
      setCursorOffset(nextCursor);
    }
    if (nextValue !== value) {
      onChange(nextValue);
    }
  };

  usePaste(
    (input) => {
      if (!focus || !enablePaste) return;
      handleInsert(input);
    },
    { isActive: focus && enablePaste },
  );

  useInput(
    (input, key) => {
      if (!focus) return;

      if (key.ctrl && input === "c") return;
      if (key.ctrl && input === "r") return;
      if (key.ctrl && input === "o") return;
      if (key.ctrl && input === "g") return;
      if (key.tab) return;

      if (pickerActive) {
        if (key.upArrow) {
          onPickerUp?.();
          return;
        }
        if (key.downArrow) {
          onPickerDown?.();
          return;
        }
        if (key.return) {
          onPickerSelect?.();
          return;
        }
        if (key.escape) {
          onPickerCancel?.();
          return;
        }
      }

      if (key.escape) {
        onCancel?.();
        setCursorOffset(0);
        return;
      }

      if (key.return) {
        let full = value;
        let hasPastes = false;
        if (enablePaste && pastesRef.current.size > 0) {
          for (const [placeholder, fullText] of pastesRef.current) {
            if (full.includes(placeholder)) {
              full = full.split(placeholder).join(fullText);
              hasPastes = true;
            }
          }
        }
        onSubmit(full, hasPastes ? value : undefined);
        pastesRef.current.clear();
        setCursorOffset(0);
        return;
      }

      if (key.upArrow) {
        onHistoryUp?.();
        return;
      }

      if (key.downArrow) {
        onHistoryDown?.();
        return;
      }

      let nextCursor = cursorOffset;
      let nextValue = value;
      let didDelete = false;

      if (key.leftArrow) {
        if (key.meta) {
          nextCursor = findWordBoundaryBackward(value, cursorOffset);
        } else {
          nextCursor = cursorOffset - 1;
        }
      } else if (key.rightArrow) {
        if (key.meta) {
          nextCursor = findWordBoundaryForward(value, cursorOffset);
        } else {
          nextCursor = cursorOffset + 1;
        }
      } else if (key.meta && input === "b") {
        nextCursor = findWordBoundaryBackward(value, cursorOffset);
      } else if (key.meta && input === "f") {
        nextCursor = findWordBoundaryForward(value, cursorOffset);
      } else if (key.meta && input === "d") {
        didDelete = true;
        const boundary = findWordBoundaryForward(value, cursorOffset);
        nextValue = value.slice(0, cursorOffset) + value.slice(boundary);
      } else if (key.home || (key.ctrl && input === "a")) {
        nextCursor = 0;
      } else if (key.end || (key.ctrl && input === "e")) {
        nextCursor = value.length;
      } else if (key.backspace) {
        didDelete = true;
        const tokenBoundary = enablePaste
          ? findPasteTokenEndingAt(value, cursorOffset, pastesRef.current)
          : -1;
        if (tokenBoundary >= 0) {
          const token = value.slice(tokenBoundary, cursorOffset);
          pastesRef.current.delete(token);
          nextValue = value.slice(0, tokenBoundary) + value.slice(cursorOffset);
          nextCursor = tokenBoundary;
        } else if (key.meta || (key.ctrl && input === "w")) {
          const boundary = findWordBoundaryBackward(value, cursorOffset);
          nextValue = value.slice(0, boundary) + value.slice(cursorOffset);
          nextCursor = boundary;
        } else if (key.ctrl) {
          const boundary = findWordBoundaryBackward(value, cursorOffset);
          nextValue = value.slice(0, boundary) + value.slice(cursorOffset);
          nextCursor = boundary;
        } else {
          if (cursorOffset > 0) {
            nextValue = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
            nextCursor = cursorOffset - 1;
          }
        }
      } else if (key.delete) {
        didDelete = true;
        if (key.meta || key.ctrl) {
          const boundary = findWordBoundaryForward(value, cursorOffset);
          nextValue = value.slice(0, cursorOffset) + value.slice(boundary);
        } else {
          nextValue = value.slice(0, cursorOffset) + value.slice(cursorOffset + 1);
        }
      } else if (key.ctrl && input === "w") {
        didDelete = true;
        const boundary = findWordBoundaryBackward(value, cursorOffset);
        nextValue = value.slice(0, boundary) + value.slice(cursorOffset);
        nextCursor = boundary;
      } else if (key.ctrl && input === "u") {
        didDelete = true;
        nextValue = value.slice(cursorOffset);
        nextCursor = 0;
      } else if (key.ctrl && input === "k") {
        didDelete = true;
        nextValue = value.slice(0, cursorOffset);
      } else if (input.length > 0 && !key.ctrl && !key.meta) {
        // Sanitize even non-paste input to prevent control-character corruption.
        const sanitized = sanitizeInput(input);
        let toInsert = sanitized;
        if (enablePaste && shouldTreatAsPaste(toInsert)) {
          const lines = countLines(toInsert);
          const id = ++pasteCounterRef.current;
          const placeholder = makePastePreview(toInsert, lines, id);
          pastesRef.current.set(placeholder, toInsert);
          toInsert = placeholder;
        }
        nextValue = value.slice(0, cursorOffset) + toInsert + value.slice(cursorOffset);
        nextCursor = cursorOffset + toInsert.length;
      }

      if (nextCursor < 0) nextCursor = 0;
      if (nextCursor > nextValue.length) nextCursor = nextValue.length;

      if (didDelete && nextValue === "" && value !== "") {
        onClearQueueItem?.(value);
      }

      if (nextCursor !== cursorOffset) {
        setCursorOffset(nextCursor);
      }
      if (nextValue !== value) {
        onChange(nextValue);
      }
    },
    { isActive: focus },
  );

  const displayValue = mask ? mask.repeat(value.length) : value;

  let renderedValue = "";
  for (let i = 0; i < displayValue.length; i++) {
    const char = displayValue[i]!;
    renderedValue += i === cursorOffset ? chalk.inverse(char) : char;
  }
  if (displayValue.length === 0) {
    renderedValue = chalk.inverse(" ");
  } else if (cursorOffset === displayValue.length) {
    renderedValue += chalk.inverse(" ");
  }

  if (width !== undefined) {
    return (
      <Box width={width}>
        <Text wrap="wrap">{renderedValue}</Text>
      </Box>
    );
  }

  return <Text>{renderedValue}</Text>;
}

export function findPasteTokenEndingAt(
  value: string,
  pos: number,
  pastes: Map<string, string>,
): number {
  if (pos <= 0 || value[pos - 1] !== "⦘") return -1;
  for (const placeholder of pastes.keys()) {
    if (placeholder.length > pos) continue;
    const start = pos - placeholder.length;
    if (value.slice(start, pos) === placeholder) return start;
  }
  return -1;
}
