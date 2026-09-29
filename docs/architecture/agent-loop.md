# Agent loop architecture

A code-grounded reference for how a KimiFlare turn actually executes. Every
non-trivial claim cites `file:line` against the source on the branch this
document lives in — when in doubt, read the line.

Scope: the spine from CLI entry to tool execution, plus the subsystems that
plug into it. UI internals and the cost-attribution CLI are covered only where
they intersect the loop. Findings (red flags, opportunities) live in the
companion doc [`agent-loop-findings.md`](./agent-loop-findings.md).

## The spine

```
src/index.tsx (Commander)
        │
        ▼
src/app.tsx ─── TurnSupervisor ─── runAgentTurn() ── runKimi() ── Workers AI
   (Ink TUI)    (supervisor.ts)    (loop.ts)         (client.ts)
        │              │                │
        │              │                ├── tools/executor.run() ── tools/*
        │              │                │       │
        │              │                │       └── reducer + artifact store
        │              │                │
        │              │                ├── memory recall / extraction (memory/)
        │              │                ├── skill routing (skills/)
        │              │                ├── code-mode sandbox (code-mode/)
        │              │                └── guardrails (loop / web fetch)
        │              │
        │              └── phase events → UI
        │
        └── pickers, modals, permission prompts, checkpoints
```

A turn is a single call to `runAgentTurn(opts)`. Inside, the loop iterates
streaming-LLM → tool-execution up to 50 times until the assistant emits a
turn with zero tool calls (normal end), the budget is exhausted, every tool
is blocked, or the abort signal fires.

## 1. Entry — `src/index.tsx` (430 LOC)

Commander dispatch. Three top-level modes:

- **Interactive** (default): renders the Ink TUI from `app.tsx`.
- **Print** (`-p, --print`): one-shot prompt, prints assistant text, exits.
- **RPC** (`--mode rpc`): JSONL-over-stdio server, delegated to `sdk/rpc.ts`.

Subcommands (memory, sessions, skills, cost, lsp, mcp, etc.) live in their own
files imported here.

Exit codes:

| Code | Meaning                              | Where                                     |
| ---: | ------------------------------------ | ----------------------------------------- |
|    0 | Normal exit                          | —                                         |
|    1 | Unhandled error                      | top-level catches                         |
|    2 | Missing config                       | startup checks                            |
|   42 | `BudgetExhaustedError`               | `src/index.tsx:392–393`                   |
|   43 | `AgentLoopError` (all tools blocked) | `src/index.tsx:397–398`                   |

Both error classes are exported from `src/agent/loop.ts:120,127` and thrown
from inside the loop (see §5).

## 2. TUI root — `src/app.tsx` (4,393 LOC)

Single React/Ink `App()` component. State surface includes session, event
log, input buffer, usage counters, permission decisions, pickers (file, slash,
mention), modals (limit, loop, command, LSP, theme, remote, inbox),
checkpoints, task list, reasoning view, themes, skill state, memory-recall
banner, intent tier, git branch.

The relevant wiring for the agent loop:

- Owns a `TurnSupervisor` instance and forwards user input to it.
- Renders the 22-callback surface exposed by `runAgentTurn` — see §5.
- Renders `AgentLoopError` as a dedicated modal (`app.tsx:2119`).

Depth on this file lives in the findings doc; it is the largest single source
file in the repo and the prime refactor target.

## 3. Supervisor — `src/agent/supervisor.ts` (82 LOC)

A thin decoupler, not a controller. Responsibilities:

- Enforce **single in-flight turn**: `startTurn()` rejects if `currentTurn`
  is non-null (`supervisor.ts:39–41`).
- Track a coarse phase: `idle | preparing | streaming | executing |
  compacting | error` (used by the UI for status pills).
- Provide a soft `killTurn()` that flips a flag; actual cancellation flows
  through the `AbortSignal` the caller passes in.

It does **no** pre-turn setup itself. Memory recall and skill routing live
inside `runAgentTurn`, not here.

## 4. Workers AI client — `src/agent/client.ts` (446 LOC)

The async generator `runKimi(opts)` is what `loop.ts` actually consumes.

### Endpoint routing (`client.ts:199–237`)

Three deployment modes, branched on config:

- **Cloud**: `https://api.kimiflare.com/v1/chat` (proxied; usage reported back
  to `…/v1/usage/report` at `client.ts:165–182`, fire-and-forget).
- **AI Gateway**: Cloudflare AI Gateway URL with cache headers.
- **Direct**: Cloudflare account AI endpoint.

Model ID is validated by regex (`client.ts:194`); must match
`@namespace/name[/version]`.

### Retry policy (`client.ts:54, 90–116`)

- `MAX_ATTEMPTS = 5` (`client.ts:54`).
- Retryable on Cloudflare error `3040` (capacity), HTTP 429, HTTP 5xx, and the
  string "Internal server error" (`client.ts:61–67`).
- Backoff: `500 * 2^attempt + random(0..250)` ms (`client.ts:116`).
- Kill-switch is detected via `detectKillSwitch()` (`client.ts:110`).

### Non-SSE response handling (`client.ts:128–139`)

If the response `Content-Type` is not `text/event-stream`, the body is parsed
as JSON and matched against two error envelopes:

- Cloudflare: `{ success: false, errors: [{ code, message }] }`
- OpenAI-style: `{ object: "error", message, code }`

Mapped to humanized error messages around lines 403–431.

### SSE consumption (`client.ts:256–343`)

Driven by `readSSE(body, signal, idleTimeoutMs)` (default `60_000` ms,
`client.ts:254`). Event types yielded back to the loop:

- `gateway_meta` — cache status, log id (from response headers).
- `reasoning` / `text` — content deltas.
- `tool_call_start` / `tool_call_args` / `tool_call_complete` — tool-call
  lifecycle, accumulated by index into a map (`client.ts:261`) and emitted in
  order at stream end (`client.ts:332–341`).
- `usage` — prompt/completion tokens.
- `done` — finish reason + final usage.

## 5. Turn loop — `src/agent/loop.ts` (896 LOC)

The centerpiece. `runAgentTurn(opts)` is a flat function with a single
`while(true)` driving turns, not a state machine.

### Hard-coded constants (verified)

| Constant                       | Value     | Where                  |
| ------------------------------ | --------- | ---------------------- |
| `DRIFT_THRESHOLD`              | `5`       | `loop.ts:138`          |
| `MAX_PROMPT_TOKENS`            | `240_000` | `loop.ts:157`          |
| `MAX_TOOL_CONTENT_CHARS`       | `10_000`  | `loop.ts:161`          |
| `LOOP_WINDOW`                  | `8`       | `loop.ts:338`          |
| `LOOP_THRESHOLD`               | `2`       | `loop.ts:339`          |
| `MAX_WEB_FETCH_PER_TURN`       | `5`       | `loop.ts:343`          |
| `WEB_FETCH_DOMAIN_THRESHOLD`   | `2`       | `loop.ts:344`          |
| Tool-iteration cap (default)   | `50`      | `loop.ts:179` (overrideable) |

### Pre-turn setup (`loop.ts:186–288`)

In order:

1. **Session-start memory recall** — awaits `opts.sessionStartRecall`
   (`loop.ts:188`), races against the abort signal, injects results as a
   system message after the last system message (`loop.ts:196–198`).
2. **Skill routing** — `selectSkills()` (`loop.ts:224–243`) chooses skill
   sections; the system prompt is rebuilt in place at `loop.ts:248–272`
   depending on the `cacheStable` flag.
3. **Reasoning history stripping** — if `KIMIFLARE_STRIP_REASONING=1`,
   removes reasoning blocks from prior assistant messages; otherwise a
   "shadow strip" measures hypothetical savings (`loop.ts:419–447`).
4. **Token estimate** — `estimatePromptTokens()`; hard error if the result
   exceeds `MAX_PROMPT_TOKENS` (`loop.ts:455–459`).

Memory recall, skill selection, and prompt rebuild all swallow non-abort
errors so a pre-turn hiccup never blocks the turn.

### Streaming phase (`loop.ts:463–524`)

Iterates `runKimi()` events, accumulating reasoning, text, and tool calls.
Tool calls are validated as they finalize (`loop.ts:507`). `lastUsage` is
captured for budget accounting.

### Tool execution phase (`loop.ts:580–816`)

For each tool call:

- **Anti-loop guardrail** (`loop.ts:584–607`). A signature
  (`name + stableStringify(args)`) is pushed into a rolling window of size
  `LOOP_WINDOW = 8`. If the same signature appears `LOOP_THRESHOLD = 2`
  times already (i.e., this is the 3rd identical call), the call is blocked
  and a warning is returned in place of execution.
- **Web-fetch spiral guardrail** (`loop.ts:609–666`). Two thresholds:
  - Total fetches per turn ≥ `MAX_WEB_FETCH_PER_TURN = 5` → block.
  - 3rd fetch to the same domain → block.
- **Code-mode branch** (`loop.ts:668–725`). If the tool is `execute_code`,
  the generated TypeScript runs in the sandbox via `runInSandbox()`;
  internal tool calls executed from the sandbox come back through the same
  executor. Output is truncated at `MAX_TOOL_CONTENT_CHARS = 10_000`
  (`loop.ts:704–708`).
- **Normal dispatch** (`loop.ts:727–815`). Calls `opts.executor.run()`,
  truncates the resulting `content` to the same 10k cap (`loop.ts:736–740`),
  then fires async memory extraction without awaiting it
  (`loop.ts:752–810`). Memory extraction errors are swallowed
  (`loop.ts:806`). Real-time drift detection increments a per-session
  accumulator on high-signal memories; at `DRIFT_THRESHOLD = 5` the
  `onKimiMdStale()` callback fires (`loop.ts:795–802`).

### Budget accounting (`loop.ts:530–574`)

After each iteration, `cumulativePromptTokens += lastUsage.prompt_tokens`.
If the cumulative count exceeds `opts.maxInputTokens` **and** the iteration
made tool calls, `budgetExhausted = true` is set for the **next** iteration,
which injects a synthesis system message and forces one final no-tools turn.
If the next turn still has tool calls, `BudgetExhaustedError` is thrown
(`loop.ts:574`).

### Termination paths

| Condition                                       | Where                  |
| ------------------------------------------------ | ---------------------- |
| Zero tool calls in the assistant message         | `loop.ts:561–578` — normal return |
| Budget exhausted and synthesis turn also had tools | `loop.ts:574`, also `:854` |
| Tool-iteration cap (default 200) reached         | `toolLimitBehavior` (`continueOnLimit` is an alias for `"continue"`): `"continue"` resets `iter` automatically (TUI, `/init`), `"stop"` ends the turn (SDK), `"throw"` errors (default; headless without `--continue-on-limit`). Never waits for input. |
| Hard ceiling (`maxTotalToolIterations`, default 5 × cap) reached | One final tool-free summary request, then the turn ends cleanly. Configurable via config, `KIMIFLARE_MAX_TOTAL_TOOL_ITERATIONS`, or `--max-total-tool-iterations`. |
| Every tool in the turn was blocked               | First time: automatic recovery instruction (change approach or answer). Again after that: one final tool-free summary request, Stop hook, then `AgentLoopError`. Never waits for input. |
| `signal.aborted`                                 | checked at `loop.ts:207, 280, 526, 582, 834` |

### State mutated across iterations

- `opts.messages` — appended with assistant message, tool results, and
  injected system messages. Caller sees post-turn state via the same array.
- `recentToolCalls` — rolling window of length ≤ `LOOP_WINDOW`.
- `driftAccumulator` (keyed per session) — incremented on high-signal
  memories, decayed by 1 per turn at turn end.
- `cumulativePromptTokens` — monotonically increases; underlies budget
  enforcement.

### Callback surface

`runAgentTurn` accepts roughly 22 optional callbacks. The most relevant ones
(grep `loop.ts` for the full list):

`onAssistantStart`, `onReasoningDelta`, `onTextDelta`, `onToolCallFinalized`,
`onToolResult`, `onWarning`, `askPermission`, `onGuardrail` (non-blocking
notification), `onKimiMdStale`, `onMemoryRecalled`, `onSkillsSelected`,
`onMetaBanner`, …

These are the boundary between the loop and the UI (or any embedder via the
SDK).

## 6. Tools layer — `src/tools/`

### Executor — `executor.ts` (238 LOC)

- Tools are stored by name in a Map (`executor.ts:66–75`). `expand_artifact`
  is registered dynamically (`executor.ts:74`).
- Argument parsing: `JSON.parse` the tool-call args string; structured failure
  string on error (`executor.ts:114–122`).
- Permission gating (`executor.ts:125–139`): if a tool has `needsPermission`
  and is not in the session-scoped `sessionAllowed` set, the `askPermission`
  callback is consulted. Decisions: `allow` (one-time), `allow_session`
  (cached for the remainder of the session), `deny`. The permission key is
  the tool name, except bash uses the first token (e.g., `bash:git`,
  `executor.ts:204–209`).
- Output handling (`executor.ts:160–180`): for `git diff/show/log -p` and
  `git stash show -p`, raw output is archived as an artifact and returned
  unreduced (the bash reducer would mangle diff context); see
  `isDiffCommand()` (`executor.ts:217–226`). Every other tool goes through
  `reduceToolOutput()` (`executor.ts:175–180`).
- Tool errors return a failed `ToolResult` rather than throwing
  (`executor.ts:191–200`).

### Registry — `registry.ts` (71 LOC)

Canonical `ALL_TOOLS` list (in order): read, write, edit, bash, glob, grep,
web_fetch, web_search, github_pr, github_issue, github_code, browser_fetch,
tasks_set, memory_remember, memory_recall, memory_forget. `toOpenAIToolDefs()`
(`registry.ts:37–46`) projects each spec into the OpenAI function-schema
format the model expects.

### Reducer — `reducer.ts` (635 LOC)

Per-tool tuned reductions:

- grep: 50 lines, 3 matches/file.
- read: 60-line outline.
- bash: 40 lines, error-block focus.
- web tools: 2–4 KB.
- default: 10 KB cap.

Raw output is always archived to the artifact store; reductions are
lossless under `expand_artifact`. The reducer dispatches via a single switch
on tool name — adding a new tool requires editing this file.

## 7. Session state & resume

### In-memory artifact store — `src/agent/session-state.ts` (222 LOC)

Bounded by `maxArtifacts = 200` and `maxTotalChars = 500_000`
(`session-state.ts:76–77`). Eviction policy is LRU-by-timestamp
(`session-state.ts:82–88`); eviction happens **before** insert so insert
always succeeds. No persistence at this layer — artifacts are serialized as
part of the session file by `src/sdk/sessions.ts`.

### Session file — `src/sdk/sessions.ts`

Persisted JSON: `id, cwd, model, createdAt, messages, sessionState,
artifactStore, checkpoints`. Resume reads the full file. Checkpoint resume
truncates `messages` to the chosen turn index. Path defaults to
`~/.local/share/kimiflare/sessions/<id>.json`.

## 8. Abort propagation — `src/util/abort-scope.ts` (84 LOC)

Parent/child scope tree. `abort()` walks children recursively
(`abort-scope.ts:42–54`). `detach()` removes a child from its parent
(`abort-scope.ts:77–83`) so a child can outlive its parent.

Threading is session → turn → tool. Bash, web-fetch, web-search, github, and
browser tools honor `ctx.signal`. Read, write, edit, glob, and grep do **not**
— see findings.

## 9. Permission modes

Set globally for the session, read by `executor.ts`:

- **plan** — strict read-only allowlist (read, glob, grep, web search,
  GitHub read-only, browser fetch). Writes, edits, mutating bash, MCP, and
  LSP renames are blocked.
- **edit** — default. Mutating tools prompt per call (with `allow_session`
  caching).
- **auto** — approve everything.

## 10. Subsystems that plug in

### Memory — `src/memory/` (~1.8K LOC)

SQLite with WAL journaling; FTS5 virtual table; per-row BLOB embeddings.
Default embedding model `@cf/baai/bge-base-en-v1.5` (768-dim) via Workers AI.

Recall (`memory/retrieval.ts`) is a 5-channel RRF fusion: topic-key 0.35,
FTS 0.20, vector 0.20, exact 0.15, raw-message 0.10. Vector candidates are
filtered by recency (`maxAgeDays`, default 90) and capped at 2000 rows.
Hypothesis queries can be LLM-synthesized to boost recall.

Extraction (`memory/extractors.ts`) is mostly deterministic — `package_json`,
`tsconfig`, `entry_point`, with an optional LLM-backed `edit_event`
extractor. Invoked fire-and-forget from `loop.ts:752–810` after each tool
call.

Default DB path: `~/.local/share/kimiflare/memory.db`.

### LSP — `src/lsp/` (~1.1K LOC across multiple files)

`LspManager` spawns a server per `(id, rootUri)` tuple. `LspConnection`
wraps the stdio/SSE transport; `LspClient` handles JSON-RPC and diagnostics.
`src/tools/lsp.ts` (`makeLspTools`) exposes hover, definition, references,
symbols, rename, codeAction, etc. as `ToolSpec`s. Servers are auto-picked by
`resolveClientForPath` using rootUri prefix match.

### MCP — `src/mcp/manager.ts` (95 LOC) + `adapter.ts` (64 LOC)

`@modelcontextprotocol/sdk` client. Two transports — `StdioClientTransport`
and `SSEClientTransport`. `mcpToolToSpec` (in `adapter.ts`) prefixes names as
`mcp_<server>_<tool>` and adapts the result envelope. `getAllTools()`
returns a flat `ToolSpec[]` merged into the executor at session init.

### Code mode — `src/code-mode/sandbox.ts` (331 LOC) + `api-generator.ts`

`runInSandbox()` prefers `isolated-vm` (true isolate, separate context, 30 s
timeout, 128 MB memory limit) and falls back to `node:vm` if `isolated-vm`
fails to load. TypeScript is transpiled via the installed `typescript`
package when available, with a regex `stripTypescript` fallback. The
exposed surface to user code is the generated tool API; no file, network, or
`child_process` access is bound into the sandbox globals. A fallback warning
is emitted once per process when `node:vm` is used.

### Skills — `src/skills/`

`router.ts` (56 LOC) runs `searchSections()` (embedding similarity over
skill section text) and `buildSkillContext()` (tier-bounded token packing:
`light=2k`, `medium=8k`, `heavy=24k`). Selected sections are injected into
the system prompt by `loop.ts` during prompt assembly. Skills live in
`~/.config/kimiflare/skills` (global) and `.kimiflare/skills` (project), as
markdown files with YAML frontmatter.

### Cost attribution — `src/cost-attribution/`

`heuristic.ts` (209 LOC) is a deterministic regex classifier over tool name
+ args + file extensions. When confidence falls below 0.6
(`classify-from-session.ts`), an LLM fallback is consulted. Output is
appended to `history.jsonl` (append-only; all-time totals derived from it).

### SDK — `src/sdk/session.ts` (555 LOC) + `rpc.ts` (183 LOC)

`createAgentSession(opts)` is the public Node API. It composes memory, LSP,
the executor, and the system prompt, and returns a session handle.

`rpc.ts` is a JSONL-over-stdio server. Commands: `prompt`, `steer`,
`follow_up`, `abort`, `get_state`, `get_messages`,
`set_permission_decision`, `close`. Each command produces an event stream
written back on stdout.

## 11. Verification

To re-validate this document against the code:

```sh
# LOC claims
wc -l src/agent/loop.ts src/agent/supervisor.ts src/agent/client.ts \
      src/agent/session-state.ts src/tools/executor.ts \
      src/tools/registry.ts src/tools/reducer.ts \
      src/util/abort-scope.ts src/index.tsx src/app.tsx \
      src/mcp/manager.ts src/mcp/adapter.ts src/code-mode/sandbox.ts

# Constants
rg -n 'MAX_PROMPT_TOKENS|MAX_TOOL_CONTENT_CHARS|LOOP_WINDOW|LOOP_THRESHOLD|MAX_WEB_FETCH_PER_TURN|WEB_FETCH_DOMAIN_THRESHOLD|DRIFT_THRESHOLD|MAX_ATTEMPTS' \
   src/agent/loop.ts src/agent/client.ts

# Exit codes
rg -n 'code 42|code 43|BudgetExhaustedError|AgentLoopError' src/

# Sanity-build (no edits made by this doc, so this just guards against drift)
npm run typecheck
```

Spot-check at least 10 random `file:line` citations after any large
refactor of the agent loop; the line ranges in this document are tied to
the source as of the commit that introduced it and will drift if not
maintained.
