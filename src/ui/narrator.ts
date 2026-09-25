/**
 * Narrator — humanizes KimiFlare's system chatter without hiding technical details.
 *
 * Design principles:
 * - File names, paths, URLs, and numbers are preserved exactly.
 * - Mechanical verbs are replaced with warmer, tier-appropriate language.
 * - The tone adapts to intent tier: light (casual), medium (focused), heavy (deliberate).
 * - Terminal space is respected — keep it concise.
 */

export type IntentTier = "light" | "medium" | "heavy";
export type TurnPhase = "generating" | "executing" | "waiting";

const TIER_VOICE: Record<IntentTier, { prefix: string; verb: string }> = {
  light: { prefix: "", verb: "" },
  medium: { prefix: "", verb: "" },
  heavy: { prefix: "", verb: "" },
};

// ── Tool titles ──────────────────────────────────────────────────────────────

export function humanizeToolTitle(
  toolName: string,
  originalTitle: string,
  tier?: IntentTier,
): string {
  // Preserve exact titles for permission-critical or data-dense tools
  if (toolName.startsWith("lsp_")) {
    return humanizeLspTitle(toolName, originalTitle, tier);
  }
  if (toolName.startsWith("mcp_")) {
    return humanizeMcpTitle(toolName, originalTitle, tier);
  }

  switch (toolName) {
    case "read":
      return pick(tier, {
        light: `Taking a quick look at ${extractPath(originalTitle)}`,
        medium: `Reading ${extractPath(originalTitle)}`,
        heavy: `Digging into ${extractPath(originalTitle)}`,
      });

    case "write":
      return pick(tier, {
        light: `Creating ${extractPath(originalTitle)}`,
        medium: `Writing ${extractPath(originalTitle)}`,
        heavy: `Drafting ${extractPath(originalTitle)}`,
      });

    case "edit": {
      const path = extractPath(originalTitle);
      const suffix = originalTitle.includes("replace_all") ? " (replace all)" : "";
      return pick(tier, {
        light: `Tweaking ${path}${suffix}`,
        medium: `Updating ${path}${suffix}`,
        heavy: `Refining ${path}${suffix}`,
      });
    }

    case "bash": {
      const cmd = extractAfter(originalTitle, "bash ");
      return pick(tier, {
        light: `Running: ${cmd}`,
        medium: `Executing: ${cmd}`,
        heavy: `Running: ${cmd}`,
      });
    }

    case "glob": {
      const pattern = extractAfter(originalTitle, "glob ");
      return pick(tier, {
        light: `Finding files: ${pattern}`,
        medium: `Searching for ${pattern}`,
        heavy: `Mapping files: ${pattern}`,
      });
    }

    case "grep": {
      const pattern = extractAfter(originalTitle, "grep ");
      return pick(tier, {
        light: `Searching for "${pattern}"`,
        medium: `Grepping for "${pattern}"`,
        heavy: `Hunting for "${pattern}"`,
      });
    }

    case "web_fetch": {
      const url = extractAfter(originalTitle, "GET ");
      return pick(tier, {
        light: `Pulling up ${url}`,
        medium: `Fetching ${url}`,
        heavy: `Retrieving ${url}`,
      });
    }

    case "tasks_set":
      return pick(tier, {
        light: "Updating the plan",
        medium: "Planning the next steps",
        heavy: "Structuring the work ahead",
      });

    case "memory_remember":
      return pick(tier, {
        light: "Jotting that down",
        medium: "Noted",
        heavy: "Committing to memory",
      });

    case "memory_recall":
      return pick(tier, {
        light: "Thinking back…",
        medium: "Recalling memories…",
        heavy: "Drawing from memory…",
      });

    case "memory_forget":
      return pick(tier, {
        light: "Letting that go",
        medium: "Forgetting",
        heavy: "Clearing from memory",
      });

    case "expand_artifact": {
      const id = extractAfter(originalTitle, "expand ");
      return pick(tier, {
        light: `Opening ${id}`,
        medium: `Expanding ${id}`,
        heavy: `Retrieving full ${id}`,
      });
    }

    default:
      return originalTitle;
  }
}

function humanizeLspTitle(
  toolName: string,
  originalTitle: string,
  tier?: IntentTier,
): string {
  // LSP tools don't have render titles currently, so originalTitle is just the tool name
  // We construct a friendly version from the tool name
  const action = toolName.replace("lsp_", "").replace(/_/g, " ");
  return pick(tier, {
    light: `Checking ${action}`,
    medium: `LSP: ${action}`,
    heavy: `LSP deep-dive: ${action}`,
  });
}

function humanizeMcpTitle(
  _toolName: string,
  originalTitle: string,
  tier?: IntentTier,
): string {
  return pick(tier, {
    light: `Using ${originalTitle}`,
    medium: `Calling ${originalTitle}`,
    heavy: `Invoking ${originalTitle}`,
  });
}

// ── Info logs ────────────────────────────────────────────────────────────────

export function humanizeInfo(text: string, tier?: IntentTier): string {
  // Compaction
  if (text.startsWith("auto-compacted:")) {
    return text.replace("auto-compacted:", "Compacted context:");
  }
  if (text === "nothing to compact yet") {
    return pick(tier, {
      light: "Plenty of room left",
      medium: "Context still has room",
      heavy: "No compaction needed yet",
    });
  }
  if (text.startsWith("compacted ") && text.includes(" turns")) {
    return text; // already human enough
  }
  if (text.startsWith("··· ") && text.includes(" earlier messages compacted ")) {
    return text;
  }

  // Memory
  if (text.startsWith("memory cleanup: removed ")) {
    const n = extractNumber(text);
    return pick(tier, {
      light: `Cleaned up ${n} stale memories`,
      medium: `Forgot ${n} stale memories`,
      heavy: `Pruned ${n} stale memories`,
    });
  }
  if (text.startsWith("memory backfill: embedded ")) {
    const n = extractNumber(text);
    return pick(tier, {
      light: `Indexed ${n} memories`,
      medium: `Indexed ${n} un-vectorized memories`,
      heavy: `Backfilled ${n} memory embeddings`,
    });
  }

  // LSP
  if (text.startsWith("LSP ready — ")) {
    return text.replace("LSP ready — ", "LSP ready (").replace(" active", " active)");
  }
  if (text === "LSP reload complete — no servers started (check config or enabled status).") {
    return pick(tier, {
      light: "LSP reloaded — no servers running",
      medium: "LSP reload complete — no servers started",
      heavy: "LSP reload complete — no servers active (check configuration)",
    });
  }

  // MCP
  if (text === "reloading MCP servers...") {
    return pick(tier, {
      light: "Reconnecting MCP servers…",
      medium: "Reloading MCP servers…",
      heavy: "Reinitializing MCP servers…",
    });
  }

  // Session
  if (text.startsWith("pruned ")) {
    const n = extractNumber(text);
    return `Cleaned up ${n} old session files`;
  }
  if (text.startsWith("resumed session ")) {
    return text.replace("resumed session", "Picked up session");
  }

  // Context fullness
  if (text.startsWith("context ") && text.includes("% full — run /compact")) {
    const pct = extractNumber(text);
    return `Context is ${pct}% full — /compact when ready`;
  }

  // Interruption
  if (text === "(interrupted)") {
    return pick(tier, {
      light: "Stopped — say 'go on' if you want me to continue",
      medium: "Interrupted — say 'go on' if you want me to continue",
      heavy: "Halted — say 'go on' if you want me to resume",
    });
  }
  if (text === "(preempted)") {
    return pick(tier, {
      light: "Switching gears…",
      medium: "Switching to your new message…",
      heavy: "Switching to your new message…",
    });
  }

  // Mode switches
  if (text.startsWith("mode: ")) {
    const mode = text.slice("mode: ".length);
    return `Switched to ${mode} mode`;
  }

  // Reasoning toggle
  if (text.startsWith("reasoning: ")) {
    const state = text.slice("reasoning: ".length);
    return `Reasoning ${state}`;
  }

  // Cost attribution
  if (text === "cost attribution enabled") return "Cost tracking on";
  if (text === "cost attribution disabled") return "Cost tracking off";

  // Update
  if (text === "no update available") {
    return pick(tier, {
      light: "You're on the latest version",
      medium: "No update available",
      heavy: "Running the latest version",
    });
  }

  // KIMI.md
  if (text === "KIMI.md generated; context loaded for future turns") {
    return pick(tier, {
      light: "Project context refreshed",
      medium: "KIMI.md generated — context loaded",
      heavy: "Project context snapshot updated",
    });
  }

  // Theme
  if (text.startsWith("theme: ") && text.includes(" — restart to apply")) {
    return text; // already fine
  }

  // Config
  if (text === "configuration saved — welcome to autopilot (formerly kimiflare)!") {
    return pick(tier, {
      light: "All set — welcome to autopilot (formerly kimiflare)!",
      medium: "Configuration saved — welcome to autopilot (formerly kimiflare)!",
      heavy: "Configuration saved — welcome to autopilot (formerly kimiflare)!",
    });
  }

  // Default: return as-is
  return text;
}

// ── Memory logs ──────────────────────────────────────────────────────────────

export function humanizeMemory(text: string, tier?: IntentTier): string {
  if (text.startsWith("recalled ")) {
    const n = extractNumber(text);
    const rest = text.slice(text.indexOf("memory") + "memory".length);
    return pick(tier, {
      light: `Remembered ${n} thing${n === 1 ? "" : "s"}${rest}`,
      medium: `Recalled ${n} memory${n === 1 ? "" : "ies"}${rest}`,
      heavy: `Recalled ${n} memory${n === 1 ? "" : "ies"}${rest}`,
    });
  }
  if (text === "memory enabled") return "Memory on";
  if (text === "memory disabled") return "Memory off";
  if (text.startsWith("cleared ")) {
    const n = extractNumber(text);
    return `Cleared ${n} memories for this repo`;
  }
  return text;
}

// ── Meta banners ─────────────────────────────────────────────────────────────

export function humanizeMeta(
  parts: { label: string; value?: string | number }[],
  tier?: IntentTier,
): string {
  if (parts.length === 0) return "";

  const tierLabel = pick(tier, {
    light: "Quick one",
    medium: "Digging in",
    heavy: "Going deep",
  });

  const rest = parts
    .filter((p) => p.label !== "tier")
    .map((p) => (p.value !== undefined ? `${p.value} ${p.label}` : p.label))
    .join(" · ");

  return rest ? `${tierLabel} · ${rest}` : tierLabel;
}

// ── Status phases ────────────────────────────────────────────────────────────

export function humanizePhase(phase: TurnPhase, tier?: IntentTier): string {
  switch (phase) {
    case "generating":
      return pick(tier, {
        light: "thinking",
        medium: "thinking",
        heavy: "reasoning",
      });
    case "executing":
      return pick(tier, {
        light: "running",
        medium: "working",
        heavy: "executing",
      });
    case "waiting":
      return pick(tier, {
        light: "ready",
        medium: "ready",
        heavy: "waiting",
      });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pick<T>(tier: IntentTier | undefined, choices: Record<IntentTier, T>): T {
  return choices[tier ?? "medium"];
}

function extractPath(title: string): string {
  // Titles are like "read src/app.tsx" or "write src/app.tsx (1234 chars)"
  const firstSpace = title.indexOf(" ");
  if (firstSpace === -1) return title;
  let rest = title.slice(firstSpace + 1);
  // Strip trailing metadata like " (1234 chars)"
  const paren = rest.indexOf(" (");
  if (paren !== -1) rest = rest.slice(0, paren);
  return rest;
}

function extractAfter(title: string, prefix: string): string {
  if (title.startsWith(prefix)) return title.slice(prefix.length);
  const idx = title.indexOf(prefix);
  if (idx !== -1) return title.slice(idx + prefix.length);
  return title;
}

function extractNumber(text: string): number {
  const m = text.match(/(\d+)/);
  return m ? parseInt(m[1]!, 10) : 0;
}
