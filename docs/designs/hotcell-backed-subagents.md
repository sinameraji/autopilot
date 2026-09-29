# Hotcell-Backed Local Subagents for Autopilot

**Status:** proposal; a manual two-sandbox spike was validated on 2026-09-28. Product integration is not implemented.

**Related code:** `src/tools/spawn-worker.ts`, `src/agent/supervisor.ts`, `src/agent/messages.ts`, `src/config.ts`

**Related design:** `docs/plans/multi-agent-standalone-workers-plan.md`, `docs/plans/multi-agent-actual-status.md`, `docs/designs/parallel-research-orchestration.md`


## Summary

Add an optional **local Hotcell worker backend** alongside Autopilot's existing remote HTTP worker endpoint. A coordinator running on the user's machine should be able to launch several isolated Hotcell sandboxes, run one ordinary Autopilot agent in each, and collect typed results/artifacts for synthesis. This is not a replacement for the current remote `spawn_worker` path; it is a local execution provider for users who have Hotcell and want private, disposable workspaces on their own hardware.

The coordinator owns the user conversation. Each worker receives a specific, bounded mission, the project/model context it needs, and an explicit resource/permission budget. Workers must not share a writable checkout. The parent reviews and integrates results; a sandbox must not silently commit, push, publish, send mail, or perform another external side effect.

## Why add this to the existing worker design

`src/tools/spawn-worker.ts` currently POSTs to `KIMIFLARE_WORKER_ENDPOINT/worker`. That remote worker contract is useful for managed/remote execution but requires a deployed service. Hotcell provides a local alternative: the host daemon creates independent sandboxes, keeps provider credentials on the host, offers a gateway URL and per-sandbox token, and supports explicit spend/resource limits.

Represent the choice as a worker-provider boundary (for example, `remote` vs `hotcell`) rather than embedding Hotcell lifecycle logic into the prompt planner. Keep today's remote behavior as the default and make a local backend opt-in. A local backend only works when the coordinator can reach the user's Hotcell daemon; a remotely hosted Autopilot process must not claim it can access the user's laptop daemon unless a separately paired, authenticated endpoint is configured.

## Manual spike: what was actually done

The spike used two fresh, independent Hotcell workspaces and two Autopilot print-mode processes, both explicitly set to the parent model `openai/gpt-6-luna`:

1. Verified that the OpenRouter provider was available in Hotcell's host key store without printing the key. The real OpenRouter credential remained in the macOS Keychain.
2. Added this **non-secret project routing manifest** at `.hotcell/env.json`:

   ```json
   {
     "version": 1,
     "vars": {
       "OPENROUTER_API_KEY": {
         "disposition": "gateway",
         "provider": "openrouter"
       }
     },
     "shapes": {}
   }
   ```

   It declares how a variable is routed; it contains no key value. Each sandbox receives a revocable gateway token, not the host's OpenRouter key.
3. From the project root, created two cells with separate workspaces, CPU/memory limits, and a hard spend cap per cell:

   ```sh
   hotcell create -n 2 \
     --name autopilot-worker \
     --egress \
     --egress-spend-cap 0.25 \
     --memory 1024 \
     --cpus 2 \
     --setup 'npm install --global autopilot-ai'
   ```

   The command returns one sandbox ID per line. The explicit `--setup` path was used rather than relying on Hotcell's `--autopilot` convenience bootstrap in this spike; the convenience path did not finish wiring the worker environment in the tested setup.
4. Dispatched independent, file-scoped missions (OpenRouter catalog/streaming transport; MCP approval-gate domain) with the exact same model ID as the coordinator. The host used Python `subprocess.run([...])` to invoke `hotcell exec` with an argument vector and `shlex.quote(prompt)`, rather than interpolating an unescaped prompt into a shell command.

   The effective worker invocation was:

   ```sh
   cd /workspace
   OPENROUTER_BASE_URL="${OPENROUTER_BASE_URL%/}/v1" \
     autopilot \
       --dangerously-allow-all \
       --max-input-tokens 14000 \
       --model openai/gpt-6-luna \
       -p '<bounded mission brief>'
   ```

   The `/v1` suffix is important: Hotcell's injected base URL ends at its OpenRouter gateway route; Autopilot's OpenRouter client appends API paths to its API root. Omitting `/v1` caused a 404. Do not pass, print, or persist the gateway token manually; let Hotcell inject it.
5. Retrieved only the requested output files using `hotcell files read <id> /workspace/<path>` into a host-side review area. The coordinator typechecked both sources, copied them into the app target, fixed a real SSE framing bug discovered by an offline smoke test, then built the iOS app and ran seven offline checks.
6. Both agents reported exit code 42 because their cumulative input-token limits were exhausted, even though the requested source files had already been written. The coordinator did **not** accept a file's existence as proof of success: it inspected the output, checked the exit state, compiled the code, and wrote/completed missing smoke coverage itself.
7. Hotcell reported approximately **$0.013 total model usage** across the two workers. The $0.25 cap was per cell, not a desired target. After results were copied and validated, the coordinator destroyed the cells, which also revoked their per-cell gateway access. No worker pushed a branch or opened a PR.

### Spike-only warning

The manual invocation used `--dangerously-allow-all` because print-mode tool approvals otherwise deny tool requests in a headless process. The processes were restricted to disposable workspaces and the Hotcell gateway, but this flag grants far more tool authority than a production worker needs. **Do not ship this invocation as the implementation.** The product path must use a narrow worker permission profile or an interactive Autopilot RPC/SDK permission bridge, with external side effects denied unless the user approves them through the coordinator.

## Proposed architecture

```text
User
  │
  ▼
Autopilot coordinator (one conversation owner)
  ├── plans bounded, preferably non-overlapping tasks
  ├── asks permission for worker creation when required
  ├── applies parent model + aggregate/per-worker budgets
  │
  ├── Hotcell provider: create N isolated cells, each with its own workspace
  │     └── Autopilot worker process (same model; narrow tools; bounded tokens)
  │           └── OpenRouter requests → host-owned Hotcell gateway → provider
  │
  ├── observes status, cost, usage, exit state, and cancellation
  ├── collects a summary plus explicit artifacts/patches
  └── synthesizes results; reviews and applies changes only in the parent
```

### Provider and worker lifecycle

1. **Preflight.** Confirm the Hotcell CLI/daemon is available, the OpenRouter gateway route is configured, and the requested model can be used. If not, fail clearly before creating cells. Do not silently switch to `DEFAULT_MODEL` or a different provider.
2. **Authorize and plan.** Reuse `spawn_worker`'s permission gate. Show the user the number of workers, mission summaries, model, workspace source, maximum aggregate spend, and whether the work is read-only or may edit files. Prefer disjoint file ownership; do not let workers race over one shared checkout.
3. **Prepare workspaces.** Give each worker an immutable base revision and isolated workspace. For the first implementation, require a committed/clean Git revision or explicit remote ref. A later snapshot-upload path may include local uncommitted changes after explicit user choice. Never copy `.env`, provider configs, keychains, cookies, or Autopilot auth stores into the workspace.
4. **Create capped cells.** Enforce `workerMaxParallel`, per-cell spend ceilings, CPU/memory/process caps, and a global task budget. Set model/provider allowlists and token/call limits where Hotcell supports them. The cap must be enforced by the gateway, not merely stated in the prompt.
5. **Run the agent.** Pass the coordinator's actual model ID explicitly (`args.model` or the current session model), plus a small task brief and required repository guidance. Preflight/validate the ID; return an actionable error if unavailable. A worker model override may be allowed only when requested. Never silently downgrade.
6. **Constrain tools.** Research workers get read-only tools. Coding workers may edit only their sandbox and run a small approved set of checks. Deny secret inspection, unrestricted host access, arbitrary network egress, MCP write tools, email/calendar actions, Git pushes, and publishing by default. A worker request for a new capability returns to the coordinator for a user decision.
7. **Stream and cancel.** Prefer Autopilot's JSONL RPC/SDK events over scraping terminal text so the parent can display queued/starting/running/blocked/completed/failed, elapsed time, tool status, and usage. Preserve request/event IDs across reconnects. Cancellation must stop the agent process, destroy the sandbox, and revoke its gateway token.
8. **Collect and validate.** Return a typed result with status, summary, usage/cost, exit code, validation results, and a bounded list of artifacts. A non-zero exit is `partial` or `failed`, never success just because files exist. The parent reviews diffs/results before applying them to its own workspace.
9. **Always clean up.** Destroy each cell in a `finally`-equivalent lifecycle path. Retain a failed workspace only through an explicit debug option with a short expiry and a visible warning.

### API/config direction

Preserve the current worker request fields where possible and add a provider-specific execution layer, e.g.:

- `workerBackend: "remote" | "hotcell"` in config or as an explicit per-call choice; `remote` remains the compatibility default.
- Carry the **current session model ID** into every worker request. `DEFAULT_MODEL` is a fallback for new sessions, not a substitute for the model active in a running conversation.
- Extend `WorkerResultMessage` (or a provider-neutral result type) with `status: complete | partial | blocked | failed`, `exitCode`, `artifacts`, per-worker model, cost/token usage, and validation output.
- Keep Hotcell CLI/SDK calls behind a `WorkerSandboxProvider` interface so tests can use a fake provider and the coordinator does not depend on sandbox-specific event formats.
- Treat egress key/token values as secrets at every boundary: no prompts, output objects, logs, telemetry, error text, shell history, or persisted worker transcript may contain them.

## User experience

- Show a compact worker group under the coordinator's current task: task label, model, state, elapsed time, and bounded cost/usage.
- Let users inspect a worker's brief, files read/changed, and validation, but keep its private chain-of-thought hidden.
- Expose a clear Stop action that cancels all or selected workers and confirms cleanup.
- Surface partial output and blockers honestly. Provide Retry/Refine rather than automatically respawning a failed worker.
- Before applying a patch, present a reviewable diff in the parent workspace. No automatic push/PR in the local backend MVP.

## Implementation sequence

### Phase A — adapter and tests

- Define a provider-neutral worker lifecycle/result interface around the existing `spawn_worker` protocol.
- Implement a fake Hotcell provider and test argument construction, model inheritance, caps, concurrency, cancellation, failure mapping, and cleanup.
- Add a small integration harness that exercises one/two Hotcell cells only when an explicit environment flag is set; redact all credential-bearing output.

### Phase B — single local worker

- Add opt-in local provider config and preflight checks.
- Launch a single read-only Autopilot worker through a supervised process/RPC session, with the session's exact model ID and a hard gateway spend ceiling.
- Collect a bounded typed result and always tear down the sandbox.

### Phase C — safe parallel workers

- Add a bounded worker pool, visible status aggregation, separate workspaces, deterministic cancellation, and aggregate-budget accounting.
- Support coding-worker artifacts as patches; require coordinator review before applying.

### Phase D — polish

- Resume/debug controls with short-lived retention, integration across the Ink/Camouflage worker list, latency/cost telemetry, and model/provider compatibility checks.
- Consider branch/PR workflows only as a separate explicit execute mode, reusing existing approval and GitHub safeguards.

## Acceptance criteria

- Two independent workers can run concurrently in separate cells with the coordinator's exact model ID; each has an independently enforced spend cap.
- The real OpenRouter key remains in host Keychain. Sandboxes receive only revocable gateway credentials. A repository scan and log-redaction test find no key material.
- Missing/invalid model, missing key route, setup failure, max-input exit, timeout, user cancellation, and non-zero process exit are surfaced as distinct actionable states.
- Cancel/timeout paths terminate the process, remove the cell, and revoke the token; tests assert cleanup even when result collection throws.
- Research mode cannot write; coding mode cannot push or call external MCP write tools. A worker cannot broaden its own permissions.
- Results are size-bounded, typed, and validated before synthesis. Artifacts are not applied to the parent workspace automatically.
- Existing remote-worker behavior and its tests remain unchanged when the local Hotcell provider is not configured.

## Open questions

- Should Hotcell be an optional external CLI dependency, or should Autopilot expose a generic sandbox-provider plugin contract?
- Should the local worker protocol use Autopilot's JSONL RPC, `createAgentSession` SDK, or a thin supervisor process? Prefer the path with reliable streaming, cancellation, and typed permission requests.
- How should the first MVP transfer the parent's Git state: clean remote ref only, a local Git bundle, or an explicit snapshot archive?
- Which resource controls (TTL, model allowlist, call/token rate, and aggregate spend) are supported by the minimum Hotcell daemon version, and how are unsupported controls rejected?
- How should worker memory/context be passed without leaking unrelated private conversation history?

## Security and compatibility note

This design complements—not supersedes—the existing remote worker and parallel-research plans. Those docs discuss planning, synthesis, and cost pathologies; this proposal focuses on a locally managed sandbox provider, host-side key gateway, model inheritance, and safe artifact transfer. Any implementation should reconcile it with `docs/designs/parallel-research-orchestration.md` and `docs/plans/multi-agent-actual-status.md` before enabling automatic spawning.

The Hotcell environment manifest is intentionally safe to version: it stores variable names and `gateway` dispositions, not values. If a future config uses `inject`, raw credential values must stay out of Git and sandbox images; prefer the gateway route.
