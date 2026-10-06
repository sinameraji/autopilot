# Agent loop architecture

How an Autopilot turn actually executes, from user input to tool execution,
including subagents and mid-turn input. Verified against `main` at
release 1.13.0 (October 2026). Prioritized problems and the work plan live in
[`agent-loop-findings.md`](./agent-loop-findings.md).

References name files and functions rather than line numbers, so they survive
edits; use `rg` to locate them.

## The spine

```
user input
  │
  ▼
host  (one of six — see "Hosts")
  │  classifyIntent()            src/intent/classify.ts      regex tier: light|medium|heavy
  │  resolveSubagentGuidance()   src/intent/subagent-policy.ts  regex + optional Jev
  │  tool list (spawn_worker filtered by guidance)
  │
  ▼
runAgentTurn(opts)               src/agent/loop.ts
  │  pre-turn: session-start memory recall ∥ semantic skill routing
  │  loop:
  │    preflight token estimate vs. model context → throw if over
  │    stream model                runKimi()  src/agent/client.ts
  │    zero tool calls → return
  │    schedule tool calls:
  │      all isReadOnly → Promise.all
  │      otherwise      → sequential
  │    executor.run()              src/tools/executor.ts  (hooks, permission, reducer)
  │    onIterationEnd()            host hook: compaction (TUI/init), steering (SDK)
  ▼
host post-turn: save session, auto-compact (TUI), drain queue
```

A turn is one call to `runAgentTurn`. It loops "stream → execute tools" until
the model answers without tool calls, a guardrail finalizes the turn, a budget
error is thrown, or the abort signal fires.

## Hosts

Six entry points call `runAgentTurn`. Each one assembles `AgentTurnOpts`
itself, so they don't all get the same features:

| Host | intent tier | subagent policy | hooks | `onIterationEnd` | memory | recall/skills | `spawn_worker` |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| TUI `src/app.tsx` (via `TurnSupervisor`) | ✓ | ✓ | ✓ | compaction | ✓ | ✓ | policy-gated |
| print `src/print-mode.ts` | ✓ | ✓ | executor | — | — | — | policy-gated |
| init `src/init/run-init.ts` | ✓ | — | — | compaction | ✓ | — | — |
| SDK/RPC `src/sdk/session.ts` | — | — | ✓ | steer queue | ✓ | — | always, no directive |
| server `src/server/routes.ts` | — | — | — | checkpoint | — | — | always, no directive |
| emit `src/emit-mode.ts` | — | — | — | — | — | — | always, no directive |

Consolidating these into one `SessionCore` is tracked in #726.

`TurnSupervisor` (`src/agent/supervisor.ts`) is used only by the TUI. Its live
surface is a single-flight guard (`startTurn` is a no-op while running), a
coarse phase, and a `killTurn()` flag; actual cancellation goes through the
`AbortSignal`. The rest of the file is remote-era decomposition and synthesis
code with no callers (#730).

## Model client — `src/agent/client.ts`

`runKimi(opts)` is an async generator over a streaming chat-completions call.

- **Providers:** OpenRouter with the user's key (default; the model catalog
  comes from OpenRouter, see `src/models/`), a custom OpenAI-compatible
  endpoint (`customEndpoint`, takes precedence), or Requesty when only a
  Requesty key is set.
- **Retries:** up to `MAX_ATTEMPTS = 5`, for network errors, 408, 429 and 5xx.
  Uses full-jitter backoff and honors `Retry-After`, with a cap.
- **Streaming:** SSE with an idle timeout of 60 s before the first byte and
  30 s after it. Both can be overridden per turn.
- **Events:** `response_meta`, `reasoning`, `reasoning_details`, `text`,
  `tool_call_start` / `_args` / `_complete`, `usage`, `done`.

## Turn loop — `src/agent/loop.ts`

### Pre-turn

1. **Memory recall** (one-shot per session): awaits `sessionStartRecall`,
   synthesizes the results, and injects them once (`injectRecalledMemoryOnce`).
2. **Skill routing:** `selectSkills()` embeds the prompt and packs skill
   sections by tier. It's skipped for light prompts under 40 characters.
3. Both run in parallel and race the abort signal. Failures other than an
   abort are swallowed.
4. If skill routing returns, the system message is **rewritten in place**
   (`messages[0]`, or `messages[1]` in cache-stable mode), together with the
   per-turn `delegationDirective`. If routing doesn't return, the directive
   is not applied (#724).

### Per iteration

- **Iteration limits:** `maxToolIterations` defaults to 200.
  `toolLimitBehavior` decides what happens when it's reached: `continue`
  resets the counter (TUI, init, server), `stop` ends the turn (SDK), and
  `throw` raises (the default). `maxTotalToolIterations` is a hard ceiling
  (default 5 × cap), followed by one tool-free summary request.
- **Context preflight:** the estimate must fit
  `contextWindow − maxCompletionTokens (default 16,384) − 8,192` for the
  selected model, otherwise the loop throws and suggests `/compact`.
  Compaction is the host's job (#717).
- **Optional history shaping:** strip historical reasoning
  (`KIMIFLARE_STRIP_REASONING`) and drop images older than
  `keepLastImageTurns`.
- **Tool scheduling:**
  - If there's more than one call and every call is `isReadOnly`, they run
    in parallel with `Promise.all`.
  - Otherwise every call runs sequentially, in order.
  - The two paths are separate copies of the per-call logic and have drifted
    apart (#729).
  - `spawn_worker` is not read-only, so worker calls always run one at a
    time (#723).
- **Per-call guardrails:**
  - Loop detection: the signature is `name + stableStringify(args)`, and the
    3rd identical call within a window of 8 is blocked.
  - Web fetch limits: 5 per turn, at most 2 to the same domain, and 25 per
    session.
  - In Code Mode, direct `read`/`bash`/`grep`/`glob` calls are redirected
    into `execute_code`, at most 4 times per turn.
  - A tool outside the turn's tool list gets an "unavailable" result.
- **Results:** content is truncated at 10,000 characters (`onTruncation`
  fires). Memory extraction runs fire-and-forget per result; errors are
  counted per session.
- **Durable runs:** a tool result carrying `waitRequest` (from `wait_for`)
  ends the turn so the run scheduler can wake it later. This is handled on
  the sequential path only.

### Termination

| Condition | Outcome |
| --- | --- |
| Assistant message with no tool calls | pending steers continue the turn; a substantial turn that stopped after only planning gets one "continue" nudge (Jev completion check); otherwise normal return (Stop hook fires) |
| Every call in an iteration blocked | 1st time: recovery instruction; 2nd: tool-free summary, then `AgentLoopError` (exit 43 in print mode) |
| `maxTotalToolIterations` reached | tool-free summary, clean return |
| Cumulative prompt tokens ≥ `maxInputTokens` | `BudgetExhaustedError` (exit 42) |
| Abort signal | `AbortError` |

The loop never blocks waiting on a user decision except through permission
prompts.

## Tools — `src/tools/`

- `ALL_TOOLS` in `executor.ts` is the registry: file, shell, search, web,
  GitHub, browser, tasks, memory, `spawn_worker`, plan options, jobs
  (`job_start`/`status`/`logs`/`cancel`) and `wait_for`. MCP and LSP tools
  are merged in per session.
- `ToolExecutor.run()` parses the arguments, then:
  1. fires `PreToolUse` hooks (which can veto the call);
  2. checks permission when `needsPermission` is set. Decisions can be
     cached for the session, keyed by tool name, or by command for `bash`.
  3. runs the tool;
  4. reduces the output (per-tool reducers, raw output archived and
     retrievable with `expand_artifact`; diffs pass through unreduced);
  5. fires `PostToolUse` hooks.

  Errors become a failed `ToolResult` with a classified error code instead of
  being thrown.
- **Permission modes** (`src/mode.ts`): `plan` (read-only allowlist),
  `edit` (default; mutating tools prompt), `auto` (approve everything).

## Subagents

Workers are **local Hotcell sandboxes only** (#720). Remote and Cloudflare
workers have been removed.

1. **Policy** (`resolveSubagentGuidance`):
   - explicit "don't delegate" → `explicit-sequential`;
   - explicit "use subagents" → `explicit-delegate`;
   - policy `off` → none;
   - sequential-dependency wording → none;
   - explicit parallel wording → `auto-delegate` or `suggest`;
   - light tier → none;
   - policy `auto` (the default) → `auto-delegate`;
   - otherwise Jev decides `suggest`/none for research-flavored prompts.

   The result sets a directive string and whether `spawn_worker` is in the
   tool list. The policy never launches a worker itself.
2. **Dispatch:** the model calls `spawn_worker({ mode: "plan", task, context? })`,
   which needs permission. `runHotcellWorker()` then:
   1. takes a slot from a process-wide semaphore (≤ 3, `workerMaxParallel`);
   2. requires a clean checkout on a named branch with a credential-free
      origin;
   3. creates a cell with an egress spend cap;
   4. runs a read-only research worker in print mode
      (`--worker-profile research`, `--max-input-tokens 14000`);
   5. reads the cell's cost stats, then removes the cell, which also
      revokes the gateway token.
3. **Result:** the worker's text comes back as the tool result. Known
   problems: the worker command only works when the target repo is Autopilot
   (#722), the budget and result format are too thin (#727), and workers
   block the coordinator for their whole run (#728).

## Mid-turn user input

- **TUI:** FIFO queue. Input while busy is queued and drained one item when
  the supervisor is idle. Editing the latest prompt interrupts and replays
  it. `/queue plan` lets the user merge queued prompts into one coordinated
  prompt (`src/agent/queue-batch.ts`). Ctrl+C aborts the turn scope,
  including any running workers.
- **SDK/RPC:**
  - `steer()` queues text that `onIterationEnd` injects as a user message.
  - `followUp()` appends after the turn.
  - `prompt()` while streaming becomes a steer.

  Known gaps are tracked in #725.

## Cancellation

`src/util/abort-scope.ts` provides a parent/child scope tree
(session → turn → tool). The turn's signal is passed to `runKimi`, the
executor, and tools; Hotcell workers kill their process and remove the cell
on abort. SDK `abort()` first denies pending permission prompts, because the
executor doesn't race them against the signal.

## Persistence and durable runs

- Sessions are JSON files in `$XDG_DATA_HOME/kimiflare/sessions/` (default
  `~/.local/share/...`): messages, session state, artifact store, and
  checkpoints. The TUI saves after every turn; the SDK saves only on success
  (#637).
- `src/agent/artifact-compaction.ts` collapses older complete turns into
  `SessionState` plus archived artifacts. It's triggered by the TUI and init
  at 80k estimated tokens or 12 turns (#717).
- Durable runs: `src/runs/` (store, intent/result journal, wake scheduler,
  worktrees) and `src/jobs/manager.ts` (detached process-group jobs with log
  files). The server host passes `runId`; `wait_for` yields a run on a timer
  or job condition.

## Other subsystems

- **Memory** (`src/memory/`): SQLite + FTS5 + embeddings, repository-scoped
  by default (`.kimiflare/memory.db`). The `memory_*` tools, plus
  fire-and-forget extraction after tool results.
- **Skills** (`src/skills/`): embedding search over skill sections, packed
  by tier budget.
- **Code Mode** (`src/code-mode/`): tools exposed as a generated TypeScript
  API, run in `isolated-vm` (with a `node:vm` fallback).
- **Hooks** (`src/hooks/`): `PreToolUse`/`PostToolUse` in the executor,
  `Stop` in the loop, and `PreCompact` in hosts.
- **MCP/LSP** (`src/mcp/`, `src/lsp/`): adapted to `ToolSpec`s with per-call
  timeouts; LSP restarts with backoff.
