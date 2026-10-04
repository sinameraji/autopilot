# Agent loop — findings and priorities

Companion to [`agent-loop.md`](./agent-loop.md). Last reviewed October 2026
against `main` at release 1.13.0. This review builds on the earlier May 2026
findings; items from that round that shipped are listed at the end.

**Goal:** a harness that coherently decides between sequential work and
parallel subagents, and handles user input that arrives mid-turn. Today
those features were added on top of a sequential loop, one at a time, and
they don't compose:

- delegation policy is decided in the hosts;
- worker execution happens inside a blocking tool call;
- the loop's scheduler doesn't know workers exist;
- the input queue doesn't know any of this is happening.

## Priorities

| P | Issue | Summary |
| --- | --- | --- |
| P0 | #722 | Hotcell workers only run when the target repo is Autopilot; unpushed `HEAD` fails setup |
| P0 | #723 | Parallel `spawn_worker` calls run sequentially, one permission prompt each |
| P1 | #724 | Subagent directive is dropped unless skill routing succeeds, and stale directives persist |
| P1 | #725 | Input coordinator: steer, interrupt, or follow up on mid-turn input; SDK steer/followUp bugs |
| P1 | #726 | SessionCore: one turn-assembly path for all six hosts |
| P1 | #717 | Budget-aware compaction for every entry point (lands with #726) |
| P1 | #637 | SDK/RPC saves only on clean turns (lands with #726) |
| P1 | #716 | Shell injection in co-author trailers |
| P1 | #727 | Worker budget too small; results unstructured |
| P2 | #728 | Background subagents on jobs + `wait_for` |
| P2 | #729 | One tool scheduler instead of two divergent loop bodies |
| P2 | #730 | Remove remote-era multi-agent dead code |
| P2 | #718 | Continue decomposing `app.tsx` (after #726) |
| P3 | — | Open items carried over from May (below) |

Suggested order:

1. **#722 + #723.** Until workers run on any repo, and in parallel, `auto`
   delegation (the default) costs time and money without delivering
   parallelism.
2. **#724 and #716.** Small and independent.
3. **#726.** Absorbs #717, #637 and the SDK half of #725, then the TUI inbox
   from #725 on top.
4. **#728**, with #729 as the enabling refactor. #730 any time.
5. **#718** continues, pulling logic *into* SessionCore rather than into more
   UI hooks.

## P0

### Workers can't run outside the Autopilot repo — #722

`runHotcellWorker()` clones the user's repo into the cell, runs `npm ci`
there, then runs `node --import tsx "$REPO_ROOT/src/index.tsx"`. That only
works if the user's repo *is* Autopilot. Elsewhere:

- the entry point doesn't exist;
- `npm ci` fails or runs the project's own install scripts in the cell.

The test asserts this command string, which is why the tests missed it.
The design spike installed the published CLI instead.

Two related problems:

- `git fetch origin <commit>` in the cell fails for any unpushed commit,
  and the clean-tree check doesn't catch that.
- `npm ci` time counts against the 5-minute research timeout.

### Worker calls never run in parallel — #723

The loop only parallelizes a batch when every call is `isReadOnly`.
`spawn_worker` is permission-gated and not read-only, so N worker calls run
back to back, with N permission prompts. The delegation directive tells the
model to delegate "in parallel", and the Hotcell semaphore (3) is never
reached from one coordinator.

## P1

### Delegation directive delivery — #724

`delegationDirective` is only written into the system prompt inside the
skill-routing success branch. Without a skills DB or working embeddings, the
model never sees the policy, but `spawn_worker` is still in its tool list.

When routing does succeed, the system prompt is overwritten in place and
persisted. A later turn whose guidance is `none` (with `spawn_worker`
filtered out) can still carry the old "use spawn_worker" directive. This was
RF-10 in May, rated low; it's a correctness bug.

### No input coordinator — #725

- **TUI:** strict FIFO; a correction waits behind the whole running turn.
  Blocking workers make that minutes.
- **SDK:**
  - steers are drained only in `onIterationEnd`, which isn't called on the
    final no-tool iteration, so a late steer leaks into the *next* prompt's
    turn after the model has already replied;
  - follow-ups are appended to history but never run;
  - `prompt()` while streaming silently becomes a steer.

The fix is an inbox owned by the session that classifies each message as
steer (inject at the next boundary, including before the final answer),
interrupt, follow-up, or command.

### Six divergent hosts — #726 (with #717, #637)

See the host table in `agent-loop.md`. Compaction, delegation policy,
steering, saving and hooks are wired per host, inconsistently. SDK, server
and emit expose `spawn_worker` without any policy directive. #717
(compaction only in TUI/init, with a fixed 80k/12-turn trigger) and #637
(SDK saves only on success) are symptoms. Fix them once, in a shared core.

### Co-author trailer injection — #716

Config and env values are interpolated into generated shell source in
`injectCoauthor()`. Exploiting it requires control of the user's own config,
hence P1 rather than P0.

### Worker budget and result shape — #727

Workers run with a 14k *cumulative* input-token budget, and the design spike
saw both workers exhaust it. Output is one unstructured blob with a
hard-coded `confidence: "medium"` and empty `filesRead`/`sources`.

## P2

- **#728, background subagents.** Workers are blocking tool calls with no
  handle, status, or per-worker cancel. Jobs, `wait_for` and the run store
  already provide the lifecycle; worker results should arrive through the
  #725 inbox.
- **#729, one scheduler.** The parallel and sequential paths in
  `runAgentTurn` duplicate per-call handling and have already drifted. The
  parallel path ignores `waitRequest`, drops `onRunBudgetExceeded`, and skips
  task auto-advance.
- **#730, dead code.** About 450 lines in `supervisor.ts` (decomposition,
  synthesis, pre-read, `ActiveWorker`) plus the related config keys and the
  `/multi-agent` stub.
- **#718, `app.tsx`** (3,041 LOC). Sequence it after #726.

## P3: open items carried over from May

- **RF-4:** loop-guardrail signatures are sensitive to nonce fields in
  arguments. Let `ToolSpec` declare a signature projector.
- **RF-11:** the Code Mode API cache is keyed by `stableStringify(tools)`;
  freeze the API per turn.
- **RF-13 (rest):** `write`/`edit` don't check `ctx.signal` at entry.
- **RF-17:** stamp artifacts with the reducer version for resumed sessions.
- **RF-12 (rest)** and **OP-7 (rest):** the TUI hint for truncated output
  and a `/memory health` surface. The callbacks already exist.
- The intent tier is a keyword regex. That's acceptable as a cheap gate (it
  only sizes the skills budget and short-circuits light prompts away from
  delegation), but nothing that spends money should key off it alone.
- **Delegation telemetry:** policy kind, worker count, setup and research
  time, cost and outcome, so the `auto` default can be judged on data
  (#660's evaluation plan).

## Shipped since the May review

- **RF-1:** memory extraction error counter and warning.
- **RF-2:** sliding-window drift detection.
- **RF-3:** session-scoped web-fetch caps.
- **RF-5:** budget check on text-only turns.
- **RF-6:** preflight derived from the model's context window rather than a
  fixed 240k.
- **RF-7:** per-call SSE idle timeouts.
- **RF-8:** full-jitter retries.
- **RF-9:** size-weighted artifact eviction.
- **RF-12:** `onTruncation` callback.
- **RF-13:** abortable grep, glob and read.
- **RF-15/16:** LSP restart, plus MCP/LSP timeouts.
- **RF-18:** now tracked as #716.
- **RF-19:** per-session sandbox fallback warning.
- **RF-20:** Ctrl+C handling.
- **OP-12:** classified tool errors.
- **#661:** loop and limit guardrails never pause unattended runs.
