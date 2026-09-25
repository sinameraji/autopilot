import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "./theme-context.js";
import { featuredModels, listModels, type ModelEntry, type ModelPricing } from "../models/registry.js";
import { fuzzyFilter } from "../util/fuzzy.js";

interface Props {
  current: string;
  onPick: (model: ModelEntry | null) => void;
  /** Optional whitelist of models. When provided, only these models are shown. */
  models?: ModelEntry[];
  /** Heading override (onboarding uses its own wording). */
  title?: string;
}

const PAGE_SIZE = 30;
const MIN_ID_WIDTH = 18;

function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function dollar(n: number): string {
  // Catalog prices are per-token decimals scaled to per-Mtok; trim float noise.
  return `$${Number(n.toPrecision(4))}`;
}

/** "$0.95 / $4 / $0.16" (input / output / cached input, USD per Mtok), or "free". */
export function formatModelPrice(p: ModelPricing): string {
  if (p.inputPerMtok === 0 && p.outputPerMtok === 0) return "free";
  const head = `${dollar(p.inputPerMtok)} / ${dollar(p.outputPerMtok)}`;
  return p.cachedInputPerMtok !== undefined ? `${head} / ${dollar(p.cachedInputPerMtok)}` : head;
}
const formatPrice = formatModelPrice;

/** Longest path-segment-aligned common prefix shared by every id. Empty if none. */
function commonSlashPrefix(ids: string[]): string {
  const first = ids[0];
  if (first === undefined) return "";
  let prefix = first;
  for (let i = 1; i < ids.length; i++) {
    const s = ids[i] ?? "";
    while (!s.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return "";
    }
  }
  const lastSlash = prefix.lastIndexOf("/");
  return lastSlash < 0 ? "" : prefix.slice(0, lastSlash + 1);
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max < 4) return s.slice(0, Math.max(1, max));
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

function padRight(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

type Row =
  | { kind: "header"; label: string; key: string }
  | {
      kind: "model";
      model: ModelEntry;
      displayId: string;
      context: string;
      price: string;
      isCurrent: boolean;
    };

interface BuildOpts {
  models: ModelEntry[];
  current: string;
  query: string;
  /** Total width of the model-id column after marker prefix. */
  idColWidth: number;
  /** Width of the context cell. */
  ctxColWidth: number;
}

/**
 * The default (unsearched) view: only the best & latest models (see
 * featuredModels — ranked live from OpenRouter's benchmark data), plus the
 * current model if it isn't among them. Everything else is one search away.
 */
function buildRowsFeatured(opts: BuildOpts): Row[] {
  const { models, current } = opts;
  const featured = featuredModels(models);
  const rows: Row[] = [];
  const push = (m: ModelEntry) =>
    rows.push({
      kind: "model",
      model: m,
      displayId: m.id,
      context: formatContext(m.contextWindow),
      price: formatPrice(m.pricing),
      isCurrent: m.id === current,
    });
  const cur = current ? models.find((m) => m.id === current) : undefined;
  if (cur && !featured.some((m) => m.id === cur.id)) {
    rows.push({ kind: "header", label: "Current", key: "__hdr_current__" });
    push(cur);
  }
  rows.push({
    kind: "header",
    label: "Best & latest — ranked by agentic + coding benchmarks",
    key: "__hdr_featured__",
  });
  for (const m of featured) push(m);
  return rows;
}

function buildRowsFlat(opts: BuildOpts): Row[] {
  // When searching, drop section headers — fewer matches survive, headers add noise.
  const { models, current } = opts;
  const rows: Row[] = [];
  for (const m of models) {
    rows.push({
      kind: "model",
      model: m,
      displayId: m.id, // keep full id during search so query targets the user typed match
      context: formatContext(m.contextWindow),
      price: formatPrice(m.pricing),
      isCurrent: m.id === current,
    });
  }
  return rows;
}

/**
 * Fuzzy search over id + display name, best matches first (the shared
 * fuzzyFilter). Equally good matches come newest-first, and `:batch`
 * variants — a duplicate of almost every model, meant for offline batch
 * jobs — are left out (still selectable with `/model <id>`).
 */
export function filterModels(models: ModelEntry[], query: string): ModelEntry[] {
  const candidates = models
    .filter((m) => !m.id.endsWith(":batch"))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  return fuzzyFilter(candidates, query, (m) => `${m.id} ${m.name ?? ""}`);
}

export function ModelPicker({ current, onPick, models, title }: Props) {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // A coding agent can't work without tool calling, so models OpenRouter
  // lists without `tools` support are hidden (still selectable via /model <id>).
  const allModels = useMemo(() => (models ?? listModels()).filter((m) => m.supports.tools), [models]);
  const filtered = useMemo(() => filterModels(allModels, query), [allModels, query]);

  // Build rows first with placeholder widths, then measure & re-pad.
  const baseOpts: BuildOpts = {
    models: filtered,
    current,
    query,
    idColWidth: MIN_ID_WIDTH,
    ctxColWidth: 6,
  };
  const rawRows: Row[] = query.trim() ? buildRowsFlat(baseOpts) : buildRowsFeatured(baseOpts);

  // Measure column widths from visible model rows.
  const modelRows = rawRows.filter((r): r is Extract<Row, { kind: "model" }> => r.kind === "model");
  const idColWidth = Math.max(
    MIN_ID_WIDTH,
    ...modelRows.map((r) => r.displayId.length),
  );
  const ctxColWidth = Math.max(6, ...modelRows.map((r) => r.context.length));

  // Pagination — pack rows into pages of up to PAGE_SIZE, but never end a page
  // on a section header. If a header would land on the last slot, push it (and
  // any consecutive trailing headers) to the next page so the section's models
  // stay visible together. Same idea for purely empty section headers.
  const pages: Row[][] = useMemo(() => {
    const out: Row[][] = [];
    let cur: Row[] = [];
    for (const row of rawRows) {
      cur.push(row);
      if (cur.length >= PAGE_SIZE) {
        // Peel off any trailing headers so the page doesn't end on one.
        const trailingHeaders: Row[] = [];
        while (cur.length > 0 && cur[cur.length - 1]!.kind === "header") {
          trailingHeaders.push(cur.pop()!);
        }
        if (cur.length > 0) out.push(cur);
        cur = trailingHeaders.reverse();
      }
    }
    if (cur.length > 0) out.push(cur);
    return out.length > 0 ? out : [[]];
  }, [rawRows]);
  const totalPages = pages.length;
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = pages[safePage] ?? [];

  const firstSelectable = useMemo(() => pageRows.findIndex((r) => r.kind === "model"), [pageRows]);

  useEffect(() => {
    setSelectedIndex(Math.max(0, firstSelectable));
  }, [firstSelectable]);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onPick(null);
      return;
    }
    if (key.leftArrow && safePage > 0) {
      setPage((p) => p - 1);
      setSelectedIndex(0);
      return;
    }
    if (key.rightArrow && safePage < totalPages - 1) {
      setPage((p) => p + 1);
      setSelectedIndex(0);
      return;
    }
    if (key.upArrow) {
      let idx = selectedIndex - 1;
      while (idx >= 0 && pageRows[idx]?.kind !== "model") idx--;
      if (idx >= 0) setSelectedIndex(idx);
      return;
    }
    if (key.downArrow) {
      let idx = selectedIndex + 1;
      while (idx < pageRows.length && pageRows[idx]?.kind !== "model") idx++;
      if (idx < pageRows.length) setSelectedIndex(idx);
      return;
    }
    if (key.return) {
      const row = pageRows[selectedIndex];
      if (row?.kind === "model") {
        onPick(row.model);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setPage(0);
      setSelectedIndex(0);
      return;
    }
    // Keystrokes typed while a render is in flight arrive together as one
    // multi-char `input` — accept all printable characters, not just 1-char input.
    const printable = input.replace(/[\x00-\x1f\x7f]/g, "");
    if (printable.length > 0 && !key.ctrl && !key.meta && !key.return && !key.escape) {
      setQuery((q) => q + printable);
      setPage(0);
      setSelectedIndex(0);
      return;
    }
  });

  // Truncate ids only if the row would visibly exceed a reasonable width.
  // Numeric columns are fixed-width; the id column flexes.
  const maxIdRender = Math.min(idColWidth, 48);

  // Header row alignment: pad each label cell to match the data column widths.
  const headerIdCell = padRight("", maxIdRender + 2); // model id col — left blank in header
  const headerCtxCell = padRight("context", ctxColWidth);
  const headerLine = `${headerIdCell}  ${headerCtxCell}  in / out / cached`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent} bold>
        {title ?? `Pick a model${current ? `  ·  current: ${current}` : ""}`}
      </Text>
      {/* Search box: always live — typing anywhere in the picker goes here. */}
      <Box borderStyle="round" borderColor={query ? theme.accent : theme.info.color} paddingX={1} marginTop={1}>
        <Text color={theme.accent}>⌕ </Text>
        {query ? (
          <Text>
            {query}
            <Text color={theme.accent}>▌</Text>
          </Text>
        ) : (
          <Text color={theme.info.color} dimColor>
            <Text color={theme.accent}>▌</Text>
            {`Search all ${allModels.length} models (fuzzy) — e.g. sonnet, gpt 6, gemini flash`}
          </Text>
        )}
      </Box>
      {query ? (
        <Text color={theme.info.color}>
          {`${modelRows.length} match${modelRows.length === 1 ? "" : "es"}`}
          {totalPages > 1 ? `  ·  page ${safePage + 1} of ${totalPages}` : ""}
        </Text>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.muted?.color ?? theme.info.color} dimColor>
          {headerLine}
        </Text>
      </Box>
      <Box flexDirection="column">
        {pageRows.map((row, i) => {
          if (row.kind === "header") {
            return (
              <Box key={row.key}>
                <Text color={theme.muted?.color ?? theme.info.color} dimColor>
                  {row.label}
                </Text>
              </Box>
            );
          }
          const isSelected = i === selectedIndex;
          const id = truncateMiddle(row.displayId, maxIdRender);
          const marker = row.isCurrent ? "● " : "  ";
          const idCell = padRight(`${marker}${id}`, maxIdRender + 2);
          const ctxCell = padRight(row.context, ctxColWidth);
          const label = `${idCell}  ${ctxCell}  ${row.price}`;
          return (
            <Box key={row.model.id}>
              <Text color={isSelected ? theme.accent : theme.info.color} bold={isSelected}>
                {isSelected ? "› " : "  "}{label}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted?.color ?? theme.info.color} dimColor>
          {safePage > 0 ? "← prev  " : ""}
          {safePage < totalPages - 1 ? "→ next  " : ""}
          ● current  ·  type to search  ·  Enter pick  ·  Esc cancel
        </Text>
      </Box>
    </Box>
  );
}
