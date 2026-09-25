<p align="center">
  <img src="docs/logo.png" alt="kimiflare" width="180">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/kimiflare"><img src="https://img.shields.io/npm/v/kimiflare?style=flat-square&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/kimiflare"><img src="https://img.shields.io/npm/dm/kimiflare?style=flat-square&color=cb3837" alt="npm downloads"></a>
  <a href="https://github.com/sinameraji/kimiflare/blob/main/LICENSE"><img src="https://img.shields.io/github/license/sinameraji/kimiflare?style=flat-square&color=2ea44f" alt="license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js >= 20">
  <img src="https://img.shields.io/badge/typescript-5.7-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <a href="https://openrouter.ai/moonshotai/kimi-k2.6"><img src="https://img.shields.io/badge/default%20model-Kimi%20K2.6-f59e0b?style=flat-square" alt="Default model: Kimi K2.6"></a>
  <a href="https://openrouter.ai"><img src="https://img.shields.io/badge/runs%20on-OpenRouter-6566f1?style=flat-square" alt="Runs on OpenRouter"></a>
</p>

<p align="center">
  <strong>A terminal coding agent that runs any model on <a href="https://openrouter.ai">OpenRouter</a> with your own key — Kimi K2.6 by default.</strong><br>
  One key, 400+ models, per-turn billed cost.
</p>

<p align="center">
  <img src="docs/demos/onboarding.gif" alt="kimiflare TUI demo" width="900">
</p>
<p align="center">
  <a href="https://kimiflare.com">Watch full demos →</a>
</p>

## How it works

KimiFlare sends every model call to **[OpenRouter](https://openrouter.ai)** using **your own OpenRouter API key** — bring-your-own-key, nothing proxied, nothing marked up. On first run you paste the key once (it's checked against OpenRouter before it's saved) and pick a model. That's the whole setup.

- **Any model, one key.** The model picker is OpenRouter's live catalog — Kimi, Claude, GPT, Gemini, DeepSeek, GLM, Qwen, free models and more — cached locally and refreshed every few hours. Switch any time with `/model`.
- **Real cost, per turn.** OpenRouter reports what each generation actually cost; the status bar shows it (a local estimate marked `≈$` only until the billed number arrives). `/cost` totals it by session, day, month and all time.
- **Reliable tool calling.** Requests only go to upstream providers that support every parameter kimiflare sends (tools above all), and OpenRouter routes tool-calling traffic to the providers with the best tool-call success rates. The status bar shows which provider served the last turn.
- **Prompt caching that stays warm.** Each session pins to one upstream provider (OpenRouter sticky routing), so the long, stable prompt prefix keeps hitting the provider's cache across turns.

## What to remember

- **262k context window** (Kimi K2.6; 1M on Kimi K3) — Read entire modules, large configs, and full stack traces without the model losing track.
- **Image understanding** — Drop image paths (PNG, JPG, WebP, GIF, BMP up to 5 MB) into any prompt. Great for UI reviews, diagrams, and screenshots.
- **Plan / Edit / Auto modes** — `plan` is a whitelist-only research mode: only read-only tools (read, glob, grep, web search, GitHub read-only, browser fetch) are allowed. Writes, edits, mutating bash, MCP tools, and LSP renames are all blocked. `edit` (default) prompts per mutating call. `auto` approves everything for trusted tasks.
- **Windows support** — OS-aware shell auto-detects `cmd.exe` / PowerShell on Windows, `bash` on Unix. The `bash` tool works out of the box on all platforms.
- **Message queuing** — Submit multiple messages while the agent is busy; they queue and auto-drain. Escape interrupts the current turn but preserves the queue.
- **Smart permission modal** — Denying a tool opens inline feedback so you can tell the agent what to do instead. Keyboard-native navigation (`↑/↓`, `j/k`, `Alt+1/2/3`).
- **Loop guardrails** — Agent hard-stops when all tools in a turn are blocked, preventing infinite token-burning cycles.
- **Persistent all-time cost history** — Append-only `history.jsonl` tracks daily usage forever, so `/cost` shows true all-time and monthly totals that survive across sessions and version updates.
- **LSP + MCP** — Semantic code intelligence (hover, go-to-definition, references, diagnostics) via Language Server Protocol. Extend with external tools via Model Context Protocol.
- **Local structured memory** — SQLite + embeddings cross-session memory. The agent recalls facts, instructions, and preferences across sessions via `remember`, `recall`, and `forget` tools.
- **Web search, GitHub, and headless browser** — Research the web, read GitHub repos, and fetch JavaScript-rendered pages without leaving your terminal.

## Recently shipped

- **OpenRouter as the model provider** — Every OpenRouter model, your own key, billed cost per turn. Replaces Cloudflare Workers AI / AI Gateway (see [Upgrading from Cloudflare](#upgrading-from-the-cloudflare-version)).
- **OS-aware shell with Windows support** — Auto-detects `cmd.exe`, PowerShell, or bash based on platform. Override with `KIMIFLARE_SHELL` or `/shell`.
- **Smart permission modal with inline feedback** — Deny a tool and immediately tell the agent what to do instead. Keyboard-native navigation with `↑/↓`, `j/k`, `Alt+1/2/3`.
- **True message queuing** — Enter queues messages while the agent is busy; Escape interrupts and auto-drains the queue.
- **Hard-stop loop guardrail** — Stops token-burning cycles when all tools in a turn are blocked.
- **Headless SDK** — Programmatic `createAgentSession` API and JSONL-over-stdio RPC mode for building on top of KimiFlare.

See the full changelog at [github.com/sinameraji/kimiflare/releases](https://github.com/sinameraji/kimiflare/releases).

## Quick start

```sh
npm install -g kimiflare
kimiflare
```

On first run kimiflare asks for your OpenRouter API key (create one at <https://openrouter.ai/keys>) and a model. That's it.

Or run without installing:

```sh
npx kimiflare
```

Requires Node.js ≥ 20.

### Your OpenRouter key

Three ways to provide it — the first one found wins:

1. **Environment:** `OPENROUTER_API_KEY` (or `KIMIFLARE_OPENROUTER_KEY`). With this set, the setup screen never appears — the way to run kimiflare headless (CI, a VM, a container).
2. **Setup screen / CLI:** paste it on first run, or run `kimiflare auth openrouter` (prompts without echo, validates, saves). Inside the TUI, `/key set <key>` replaces it.
3. **Config file:** `"openrouterApiKey": "sk-or-…"` in `~/.config/kimiflare/config.json` (created with mode 600).

`/key` shows which key is in use, what it has spent and how much credit is left. Model calls — including memory embeddings and small internal side-calls (summaries, memory extraction) — are all billed to this key.

A key with no credits can still use OpenRouter's **free models** (the "Free" section of `/model`, ids ending in `:free`), subject to OpenRouter's daily request cap.

### Upgrading from the Cloudflare version

Earlier kimiflare versions ran on Cloudflare Workers AI / AI Gateway. On the first launch after upgrading you'll be asked for an OpenRouter key once; after that:

- Your settings (theme, MCP/LSP servers, hooks, memory, sessions, cost history) carry over.
- Model ids are migrated (`@cf/moonshotai/kimi-k2.6` → `moonshotai/kimi-k2.6`, and so on), and the retired Cloudflare fields (OAuth login, gateway, Unified Billing, provider keys) are removed from `config.json`.
- Memory keeps working unchanged: embeddings use the same `bge-base-en-v1.5` model, now via OpenRouter.
- `/gateway`, `kimiflare auth cloudflare`, `--cloud` and the Cloud-only commands are gone. `/multi-agent` (Commute) still deploys to your Cloudflare account and keeps using `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` for that.

### Model

The default is **Kimi K2.6** (`moonshotai/kimi-k2.6`, 262k context, reasoning, tools, vision). The model picker (`/model`) pins kimiflare's recommended models on top, then OpenRouter's free models, then every other tool-capable model grouped by vendor; type to search. Or set one directly:

```sh
/model moonshotai/kimi-k3          # 1M context
/model anthropic/claude-sonnet-5
/model deepseek/deepseek-v4-flash
kimiflare -m moonshotai/kimi-k2.7-code -p "..."
```

Any OpenRouter model id works, including variants like `:free` and `:nitro`. Models OpenRouter lists without tool calling are hidden from the picker — a coding agent needs tools.

**Provider routing (optional).** OpenRouter serves most models through several upstream providers. kimiflare always requires providers that support every parameter it sends, and otherwise leaves routing to OpenRouter (price-weighted, uptime-aware, tool-calling quality first, sticky per session for caching). To steer it, add an `openrouterProvider` object to the config file — any of OpenRouter's [provider preferences](https://openrouter.ai/docs/guides/routing/provider-selection):

```json
{ "openrouterProvider": { "ignore": ["SomeProvider"], "data_collection": "deny" } }
```

Avoid `order` / `sort` unless you need them: they turn off sticky routing, which is what keeps the prompt cache warm.

### Custom gateway endpoint

Point every model call at your own OpenAI-compatible endpoint instead of OpenRouter — useful when a
host application (CI, an agents platform, a container) fronts model access with its own broker and
doesn't want to hand kimiflare a raw provider key:

```sh
export KIMIFLARE_BASE_URL="https://your-broker.example.com/v1"  # /chat/completions is appended
export KIMIFLARE_API_KEY="<bearer for that endpoint>"           # optional; header omitted if unset
kimiflare -p "..."        # or --mode rpc — no OpenRouter key needed
```

The same pair can be persisted in `~/.config/kimiflare/config.json` as `baseUrl` / `apiKey`
(env vars win over the file, field by field). When a base URL is configured:

- Chat requests go to `<baseUrl>/chat/completions` and memory embeddings to `<baseUrl>/embeddings`,
  with `Authorization: Bearer $KIMIFLARE_API_KEY` (no `Authorization` header at all when the key is
  unset — e.g. a local llama.cpp/Ollama server).
- Model ids pass through in the request body unchanged; your endpoint owns provider dispatch.
- Cost is the local estimate only — your endpoint does its own metering.

### One-shot mode

```sh
kimiflare -p "summarize PLAN.md"                    # stream answer to stdout
kimiflare -p "..." --dangerously-allow-all          # auto-approve mutating tools (for scripts)
kimiflare -p "..." --reasoning                      # include chain-of-thought in stderr
```

### Headless SDK

Use KimiFlare programmatically from your own application — no TUI required.

```ts
import { createAgentSession } from "kimiflare/sdk";

const { session } = await createAgentSession({
  cwd: "/path/to/project",
  config: {
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    model: "moonshotai/kimi-k2.7-code",
  },
});

// Stream every event: text deltas, tool calls, tasks, usage
session.subscribe((event) => {
  console.log(event.type, event);
});

// Send a prompt
await session.prompt("Refactor auth to JWT + Redis");

// Mid-flight correction while the agent is still running
await session.steer("Use Redis instead of in-memory store");

// After the turn finishes
await session.followUp("Also add unit tests");

// Clean up
session.dispose();
```

**Key features:**
- `subscribe()` — receive typed events (`text_delta`, `tool_call`, `tool_result`, `task_update`, `usage`, `warning`, `error`, `done`, etc.)
- `prompt()` / `steer()` / `followUp()` — full conversation lifecycle
- `pause()` / `resume()` — graceful preemption
- `getStatus()` / `getUsage()` — inspect session state
- Custom `permissionHandler` — decide programmatically whether to allow mutating tools
- Optional `memoryEnabled`, `lspEnabled`, `costAttribution` flags

#### SDK Authentication

The SDK needs an OpenRouter API key — or a [custom gateway endpoint](#custom-gateway-endpoint)
(`baseUrl` / `apiKey` in `config`, or `KIMIFLARE_BASE_URL` / `KIMIFLARE_API_KEY`), in which case no
OpenRouter key is required. Resolved in this priority order:

1. **Explicit `config` object** (`openrouterApiKey`) — recommended for apps
2. **Environment variables**: `OPENROUTER_API_KEY` / `KIMIFLARE_OPENROUTER_KEY`
3. **Config file**: `~/.config/kimiflare/config.json`

Pass `provider` in `createAgentSession` options to set OpenRouter provider-routing preferences for that session.

**For Electron / desktop apps**, we recommend storing the key in the OS keychain (e.g. Electron `safeStorage` or `keytar`) and passing it explicitly:

```ts
import { createAgentSession } from "kimiflare/sdk";

const openrouterApiKey = await keytar.getPassword("kimiflare", "openrouter");

const { session } = await createAgentSession({
  cwd: projectPath,
  config: { openrouterApiKey },
});
```

#### RPC mode (subprocess)

If you need process isolation or a non-Node consumer, run KimiFlare in JSONL-over-stdio RPC mode:

```sh
node bin/kimiflare.mjs --mode rpc
```

Give the subprocess `OPENROUTER_API_KEY` — or a [custom gateway endpoint](#custom-gateway-endpoint)
(`KIMIFLARE_BASE_URL` + `KIMIFLARE_API_KEY`), ideal for host apps that broker model access themselves.

```ts
import { spawn } from "node:child_process";

const proc = spawn("npx", ["kimiflare", "--mode", "rpc"], {
  cwd: projectPath,
  stdio: ["pipe", "pipe", "pipe"],
});

// Read events
proc.stdout.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    console.log(event.type, event);
  }
});

// Send commands
proc.stdin.write(JSON.stringify({ type: "new_session" }) + "\n");
proc.stdin.write(JSON.stringify({ type: "prompt", message: "Hello" }) + "\n");

// Resolve a permission request
proc.stdin.write(
  JSON.stringify({ type: "resolve_permission", requestId: "req_0", decision: "allow" }) + "\n"
);

// Resume a previous session after a process restart (the `new_session`
// response echoes back the sessionId to store for later)
proc.stdin.write(JSON.stringify({ type: "new_session", sessionId: "sdk-session-…" }) + "\n");
```

### Image understanding

```sh
kimiflare
› fix the layout bug in this screenshot docs/bug.png
› convert this mockup design.png to Tailwind HTML
```

## Slash commands

| Command | Effect |
|---------|--------|
| `/mode edit\|plan\|auto` | Switch permission mode |
| `/shell auto\|bash\|cmd\|powershell` | Show or set the shell for the bash tool |
| `/thinking low\|medium\|high` | Reasoning effort (persists) |
| `/theme` | Interactive theme picker (`Ctrl+T`) |
| `/resume` | Pick a past conversation to restore |
| `/compact` | Summarize older turns to free context |
| `/init` | Scan repo and write `KIMI.md` project context |
| `/memory` | Show memory stats and search |
| `/mcp list` / `/mcp reload` | Manage MCP servers |
| `/reasoning` | Toggle chain-of-thought display |
| `/model` | Pick a model from OpenRouter's catalog (or `/model <id>`, `/model list [filter]`) |
| `/key` | Show your OpenRouter key's spend and credit (`/key set <key>`, `/key clear`) |
| `/cost` | Show OpenRouter-confirmed cost by session, day, month and all time |
| `/update` | Check for updates |
| `/help` | List all commands |

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+C` / `Esc` | Interrupt current turn when busy; exit when idle |
| `Ctrl+R` | Toggle reasoning display |
| `Ctrl+O` | Toggle verbose tool output |
| `Ctrl+T` | Open theme picker |
| `Shift+Tab` | Cycle mode (edit → plan → auto) |
| `↑` / `↓` | Walk prompt history |

## Logs

KimiFlare writes structured JSON logs of agent-side activity (tool calls,
permission decisions, MCP/LSP lifecycle, session events, errors) to
`~/.config/kimiflare/logs/<date>.jsonl`, one file per day, with 7-day
retention pruned automatically at startup.

The logs deliberately exclude prompts and completions. To capture full
request/response payloads locally for debugging, run with
`KIMIFLARE_DUMP_LLM=1`; each generation is also visible in your
[OpenRouter activity log](https://openrouter.ai/activity).

```sh
kimiflare logs path             # today's file
kimiflare logs dir              # log directory
kimiflare logs prune            # delete files older than 7 days

# Tail this session's activity, formatted:
tail -f $(kimiflare logs path) | jq

# Find the slowest tool calls in the last day:
jq -r 'select(.event == "tool:end") | "\(.data.duration_ms)\t\(.data.tool)"' \
  $(kimiflare logs path) | sort -rn | head
```

Disable the file sink entirely with `KIMIFLARE_LOG_SINK=off`. The
separate `KIMIFLARE_LOG_LEVEL` env var (default `off`) controls stderr
output — independent of the file sink.

### Shipping to an OpenTelemetry collector

If you set `KIMIFLARE_OTEL_ENDPOINT`, KimiFlare also ships each log
entry to that endpoint over [OTLP/HTTP](https://opentelemetry.io/docs/specs/otlp/)
so it lands in Datadog, Honeycomb, Grafana Loki, an internal collector,
or any other backend that speaks OTel. Batched every 5 s (or every
100 entries, whichever first) and best-effort — never blocks the agent
loop.

```sh
# Full path:
export KIMIFLARE_OTEL_ENDPOINT="https://otel.example.com/v1/logs"
# Or just the base URL (we auto-append /v1/logs):
export KIMIFLARE_OTEL_ENDPOINT="https://otel.example.com"

# Optional headers (comma-separated key=value pairs) — e.g. for auth:
export KIMIFLARE_OTEL_HEADERS="Authorization=Bearer xyz,X-Tenant=acme"
```

Each log entry maps to one OTel `LogRecord`. Correlation IDs
(`session_id`, `turn_id`, `request_id`) become record attributes,
`data.*` fields are flattened to attributes with type-preserving
encoding, and a `service.name=kimiflare` + `service.version` pair sits
on the resource.

## Hooks

KimiFlare can fire shell commands at five points in an agent turn,
configured per-project (`.kimiflare/settings.json`) or globally
(`~/.config/kimiflare/settings.json`):

| Event              | Fires when                                      | Veto? |
|--------------------|-------------------------------------------------|-------|
| `PreToolUse`       | A tool call is about to run                     | Yes   |
| `PostToolUse`      | A tool call just finished                       | No    |
| `UserPromptSubmit` | You hit Enter on a prompt                       | Yes   |
| `Stop`             | A turn ended cleanly                            | No    |
| `PreCompact`       | Auto-compaction is about to run                 | No    |

Hooks receive the event payload as JSON on stdin **and** as
`KIMIFLARE_HOOK_*` env vars (for shell-one-liner ergonomics).
Non-zero exit on a veto event cancels the underlying action and
surfaces the hook's stdout as the rejection reason.

### Browse + enable from the TUI

```text
/hooks                            # list configured hooks
/hooks recommended                # list starter hooks shipped with kimiflare
/hooks enable stop-bell           # enable one (writes to .kimiflare/settings.json)
/hooks enable stop-bell global    # ...or the global file
/hooks disable stop-bell
/hooks path                       # print settings.json paths
/hooks reload                     # re-read settings.json after a manual edit
```

The recommended catalog includes terminal bells / macOS notifications
on `Stop`, secret-file guards on `PreToolUse` (e.g. block edits to
`*.env`), auto-format-with-prettier on `PostToolUse`, and a tool-call
audit log. All ship disabled — `/hooks recommended` lists them.

### Schema example

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "id": "no-secrets",
        "matcher": "^(edit|write)$",
        "command": "case \"$KIMIFLARE_HOOK_PATH\" in *.env|*.pem) echo 'blocked'; exit 1;; esac"
      }
    ],
    "PostToolUse": [
      {
        "id": "format-ts",
        "matcher": "^(edit|write)$",
        "command": "npx --no-install prettier --write \"$KIMIFLARE_HOOK_PATH\" >/dev/null 2>&1 || true"
      }
    ],
    "Stop": [
      { "id": "bell", "command": "printf '\\a'" }
    ]
  }
}
```

Per-hook fields:
- `command` (required) — the shell command.
- `matcher` (optional) — anchored regex matched against the tool name
  for `PreToolUse` / `PostToolUse`. Ignored for other events.
- `id` (optional) — stable handle for `/hooks enable|disable`.
  Auto-derived from `event + command` when omitted.
- `enabled` (default `true`) — set `false` to keep a hook in config
  but skip it.
- `timeoutMs` (default `30000`) — hard kill if the hook hangs.
- `description` (optional) — shown by `/hooks list`.

Hooks are always-on infrastructure: they fire whether the TUI is open
or kimiflare is running in `--print` mode. They also fire for tool
calls generated from inside the Code Mode sandbox (heavy-tier turns),
because hook firing lives on the `ToolExecutor` itself — every call
path uses the same plumbing.

When intent classification has assigned a tier, hook payloads include
it as `tier: "light" | "medium" | "heavy"` (on `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`) and as `$KIMIFLARE_HOOK_TIER`. Useful for
"skip auto-format on light turns" or "audit every heavy-turn write."

SDK consumers opt in to hooks with `enableHooks: true` on
`createAgentSession`. Default is off because the SDK is a primitive,
not the TUI.

## Development

```sh
git clone https://github.com/sinameraji/kimiflare
cd kimiflare
npm install
npm run build
npm link
```

Scripts:
- `npm run build` — bundle with tsup
- `npm run dev` — run via tsx
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — run tests

## Contributing

1. Fork the repository
2. Create a branch: `git checkout -b feat/your-feature`
3. Make your changes
4. Run `npm run typecheck` and `npm run build`
5. Commit with [Conventional Commits](https://www.conventionalcommits.org/)
6. Open a Pull Request

---

Built by [Sina Meraji](https://github.com/sinameraji) and [contributors](https://github.com/sinameraji/kimiflare/graphs/contributors) · MIT License
