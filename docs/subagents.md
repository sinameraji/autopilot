# Using subagents

Autopilot can start separate workers to research independent parts of a task and return findings to the main session. The main agent remains the coordinator: it decides whether parallel work is worthwhile, combines results, and handles dependent implementation.

## Automatic delegation

`/subagents auto` is the default. For a substantial request, the coordinator assesses its structure, dependencies, and coordination cost. It may send independent research tracks to read-only workers, wait for their results, and synthesize them before continuing. You do not need to say use subagents.

Auto is conditional, not a promise to spawn: small, tightly coupled, or sequential tasks stay in the main session. A worker only starts if the coordinator calls it and the normal permission flow allows it. Automatic delegation uses read-only plan workers; it does not silently ask a worker to change files or open a PR.

Try a normal request such as:

> Audit authentication end to end. Map token issuance, refresh, and revocation separately, then give me one synthesized list of risks and recommended fixes.

Or explicitly ask for parallel research:

> Compare the three candidate libraries independently, covering maintenance, security, and migration effort. Use read-only workers where useful, then synthesize a recommendation before changing code.

Keep dependent implementation sequential:

> Update the config schema, migrate the stored format, then change the CLI parser to consume it in that order. Keep this work in the main session; do not delegate.

## Controls

- `/subagents` or `/subagents help` — show the current setting and controls.
- `/subagents auto` — proactively let the coordinator assess substantial tasks (default).
- `/subagents suggest` — use the conservative, signal-based suggestion policy.
- `/subagents off` — disable automatic delegation suggestions.

An explicit instruction for or against delegation takes precedence for that turn, including when the automatic policy is off. The mode setting controls the harness guidance; it does not force the model to spawn a worker.

## Approval, cost, and limits

Worker calls go through Autopilot’s regular permission checks. `/subagents auto` does not bypass an approval request, configured permission rules, provider restrictions, or worker limits. You can deny a worker call and continue without it.

Workers make additional model calls and can add cost and latency. The default budget is $1 per worker, with a default hard ceiling of $5; each worker has a five-minute timeout. Hotcell defaults to at most three concurrent workers. A remote worker service may also enforce its own limits. Configure limits with `KIMIFLARE_WORKER_BUDGET_USD`, `KIMIFLARE_WORKER_BUDGET_MAX_USD`, `KIMIFLARE_WORKER_TIMEOUT_MS`, and `KIMIFLARE_WORKER_MAX_PARALLEL`.

## Configure a worker backend

Delegation needs a worker backend in addition to your model-provider setup. The default backend selection is `remote`, but Autopilot does not provide a remote worker endpoint automatically. If no backend is configured, the worker tool reports that clearly and the coordinator can continue locally.

### Remote worker service

Configure a service that accepts Autopilot’s `POST /worker` endpoint. Set the endpoint in the config file as `workerEndpoint` or in the environment:

```sh
export KIMIFLARE_WORKER_BACKEND=remote
export KIMIFLARE_WORKER_ENDPOINT=https://your-worker.example
export KIMIFLARE_WORKER_API_KEY=your-worker-secret # if your service requires it
```

The secret can also be stored as `workerApiKey` in the config. Remote workers support `plan` (read-only research) and `execute` (write-enabled work that creates a branch and PR). Automatic delegation uses `plan`; `execute` is not launched automatically.

### Hotcell sandbox worker

Hotcell is an opt-in, isolated backend for read-only plan workers. Set `workerBackend: "hotcell"` in the config instead of using the environment variable if preferred:

```sh
export KIMIFLARE_WORKER_BACKEND=hotcell
```

Hotcell requires an OpenRouter-backed session (custom model endpoints and Requesty sessions are not supported). The Hotcell daemon needs an OpenRouter gateway route; configure it on the daemon host with `hotcell keys add openrouter`. The current repository must be a clean Git checkout on a named branch with a credential-free HTTPS or SSH origin that the daemon can clone. Hotcell workers see the committed snapshot, not uncommitted edits. Hotcell supports plan/read-only mode only; execute mode is unavailable.

## If a worker cannot run

Autopilot reports setup and provider errors in the worker result—for example, when the remote endpoint is missing or Hotcell cannot use the current provider. Configure a supported backend and try again. If a worker fails or you deny its permission request, the coordinator should say so and continue locally rather than imply that a worker ran.

For the upstream design inspiration, see [Anthropic’s guide to when to use subagents](https://claude.com/blog/subagents-in-claude-code) and the [Claude Code subagents documentation](https://code.claude.com/docs/en/sub-agents).
