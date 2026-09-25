import type { SlashItem } from "./types.js";

/**
 * Built-in slash commands shown in the `/`-trigger picker. Handlers may
 * still exist for commands not listed here (users can type them manually).
 */
export const BUILTIN_COMMANDS: SlashItem[] = [
  { name: "help", description: "Show keybindings and command list", source: "builtin" },
  { name: "model", argHint: "[list|<id>]", description: "Pick model (no args opens picker)", source: "builtin" },
  { name: "mode", argHint: "edit|plan|auto", description: "Switch agent mode", source: "builtin" },
  { name: "multi-agent", argHint: "[enable|disable|status|setup]", description: "Configure multi-agent (endpoint, auto-implement, set up)", source: "builtin" },
  { name: "theme", argHint: "[<name>]", description: "Switch color theme", source: "builtin" },
  // Ink is the only UI engine; handler remains for manual use.
  // { name: "ui", argHint: "ink", description: "Switch UI engine to React Ink (takes effect on next launch). Camouflage is temporarily unavailable.", source: "builtin" },
  { name: "memory", argHint: "[on|off|clear|search ...]", description: "Manage memory", source: "builtin" },
  { name: "cost", argHint: "[on|off]", description: "Show cost report or toggle attribution", source: "builtin" },
  { name: "key", argHint: "[set <key>|clear]", description: "Show or replace your OpenRouter API key", source: "builtin" },
  { name: "mcp", argHint: "[list|reload]", description: "Manage MCP servers", source: "builtin" },
  { name: "lsp", argHint: "[config|list|reload|scope]", description: "Manage language servers", source: "builtin" },
  { name: "hooks", argHint: "[list|recommended|enable <id>|disable <id>|path|reload]", description: "Manage lifecycle hooks", source: "builtin" },
  { name: "skills", argHint: "[list|add|edit|delete|enable|disable]", description: "Manage skills", source: "builtin" },
  { name: "command", argHint: "[create|edit|delete|list]", description: "Manage custom slash commands", source: "builtin" },
  { name: "resume", description: "Pick a past conversation to resume", source: "builtin" },
  { name: "checkpoint", argHint: "[label]", description: "Save current point in session", source: "builtin" },
  { name: "checkpoints", description: "List checkpoints in current session", source: "builtin" },
  { name: "compact", description: "Summarize old turns to free context", source: "builtin" },
  { name: "clear", description: "Clear current conversation", source: "builtin" },
  { name: "fresh", description: "Start a fresh session with a summarized plan or continuation context", source: "builtin" },
  { name: "init", description: "Scan repo and write KIMI.md", source: "builtin" },
  { name: "remote", argHint: "<prompt>", description: "Run a remote session on Cloudflare", source: "builtin" },
  { name: "update", description: "Check for updates", source: "builtin" },
  { name: "hello", description: "Send a voice note to the creator", source: "builtin" },
  { name: "shell", argHint: "[auto|bash|cmd|powershell|<path>]", description: "Show or set shell for bash tool", source: "builtin" },
  { name: "changelog-image", argHint: "[owner/repo] [days]", description: "Generate a changelog image from merged PRs", source: "builtin" },
  { name: "logout", description: "Clear stored credentials", source: "builtin" },
  { name: "exit", description: "Exit autopilot (formerly kimiflare)", source: "builtin" },
];

export const BUILTIN_COMMAND_NAMES = new Set(
  BUILTIN_COMMANDS.map((c) => c.name.toLowerCase()),
);
