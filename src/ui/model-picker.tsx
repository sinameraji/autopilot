import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "./theme-context.js";
import {
  isFreeModel,
  listModels,
  RECOMMENDED_MODEL_IDS,
  vendorOf,
  type ModelEntry,
  type ModelPricing,
} from "../models/registry.js";
import { fuzzyFilter } from "../util/fuzzy.js";

interface Props {
  current: string;
  onPick: (model: ModelEntry | null) => void;
  /** Optional whitelist of models. When provided, only these models are shown. */
  models?: ModelEntry[];
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
 * Sections, in order: kimiflare's recommended models, OpenRouter's free
 * models, then every other model grouped by vendor (alphabetical). Within the
 * free and vendor sections the vendor prefix is stripped when it's shared.
 */
function buildRowsGrouped(opts: BuildOpts): Row[] {
  const { models, current } = opts;
  const recommended = RECOMMENDED_MODEL_IDS.map((id) => models.find((m) => m.id === id)).filter(
    (m): m is ModelEntry => !!m,
  );
  const shown = new Set(recommended.map((m) => m.id));
  const free = models.filter((m) => !shown.has(m.id) && isFreeModel(m));
  for (const m of free) shown.add(m.id);
  const byVendor = new Map<string, ModelEntry[]>();
  for (const m of models) {
    if (shown.has(m.id)) continue;
    const v = vendorOf(m.id);
    const arr = byVendor.get(v) ?? [];
    arr.push(m);
    byVendor.set(v, arr);
  }

  const rows: Row[] = [];
  const section = (label: string, key: string, list: ModelEntry[], stripPrefix: boolean) => {
    if (list.length === 0) return;
    rows.push({ kind: "header", label, key: `__hdr_${key}__` });
    const prefix = stripPrefix ? commonSlashPrefix(list.map((m) => m.id)) : "";
    for (const m of list) {
      rows.push({
        kind: "model",
        model: m,
        displayId: prefix && m.id.startsWith(prefix) ? m.id.slice(prefix.length) : m.id,
        context: formatContext(m.contextWindow),
        price: formatPrice(m.pricing),
        isCurrent: m.id === current,
      });
    }
  };
  section("Recommended", "recommended", recommended, false);
  section("Free (daily request cap)", "free", free, false);
  for (const v of [...byVendor.keys()].sort()) section(v, v, byVendor.get(v)!, true);
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
 * Search the catalog: every whitespace-separated term must appear literally in
 * the id or name ("kimi" → only Kimi models, "claude sonnet" → Sonnets).
 * Only when nothing matches literally does it fall back to fuzzy
 * (subsequence) matching, which on a 400+ model catalog would otherwise
 * match almost everything.
 */
export function filterModels(models: ModelEntry[], query: string): ModelEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  const terms = q.split(/\s+/);
  const hay = (m: ModelEntry) => `${m.id} ${m.name ?? ""}`.toLowerCase();
  const literal = models.filter((m) => {
    const h = hay(m);
    return terms.every((t) => h.includes(t));
  });
  if (literal.length > 0) return literal;
  return fuzzyFilter(models, q, (m) => `${m.id} ${m.name ?? ""}`);
}

export function ModelPicker({ current, onPick, models }: Props) {
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
  const rawRows: Row[] = query.trim() ? buildRowsFlat(baseOpts) : buildRowsGrouped(baseOpts);

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
    if (input.length === 1 && !key.ctrl && !key.meta && !key.return && !key.escape) {
      setQuery((q) => q + input);
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
        Pick a model  ·  current: {current}
      </Text>
      <Text color={theme.info.color}>
        {query ? `Search: ${query}▌` : "Type to search…"}
        {totalPages > 1 ? `  ·  Page ${safePage + 1} of ${totalPages}` : ""}
        {`  ·  ${modelRows.length} model${modelRows.length === 1 ? "" : "s"}`}
      </Text>
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
