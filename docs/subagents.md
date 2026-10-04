# Local Hotcell subagents

Autopilot runs delegated research workers in **local Hotcell sandboxes only**. There is no remote worker endpoint or remote worker execution mode. The coordinator owns the conversation, decides whether parallel research is useful, and applies any changes itself.

## Automatic delegation

**/subagents auto** is the default. For substantial requests, the coordinator may split independent research into bounded missions, launch read-only plan workers, wait for their results, and synthesize them. Small, sequential, or tightly coupled work stays in the main session. An explicit request for or against delegation takes precedence.

**/subagents suggest** requests conservative suggestions; **/subagents off** disables automatic suggestions. Worker calls still require normal tool permission. When the coordinator launches several workers in one step they run in parallel, and a single prompt listing every mission approves (or denies) the whole batch. Running subagents are listed above the prompt with their elapsed time; `/subagents list` shows them and `/subagents cancel <n>` (or `/subagents cancel all`) stops one without interrupting the turn or the other workers. These commands run immediately even while the agent is busy. Interrupting a turn (Ctrl+C) is separate and still stops everything. **/multi-agent** is retired and no longer configures remote workers or deploys Cloudflare workers.

Automatic subagents are for research only. Workers cannot edit files, open PRs, or execute the old remote execute mode. The coordinator performs implementation in the local checkout after reviewing findings.

## Hotcell requirements

- Install and start the Hotcell CLI/daemon locally.
- Configure the daemon's OpenRouter gateway route with `hotcell keys add openrouter` on the daemon host.
- Use an OpenRouter-backed Autopilot session. Requesty and custom OpenAI-compatible endpoints are not supported for Hotcell workers.
- Run from a clean Git checkout on a named branch with a credential-free HTTPS or SSH origin that the daemon can clone. Workers inspect the exact committed revision; uncommitted and untracked files are not included. That commit must already be pushed to `origin` (the cell clones from it), so `git push` before delegating.
- Each cell installs the Autopilot CLI matching your local version (`autopilot-ai@<version>`) into a private prefix; your project's own dependencies and install scripts are never run. Set `KIMIFLARE_WORKER_PACKAGE` to override the npm spec (for example a tarball while developing Autopilot), and `KIMIFLARE_WORKER_SETUP_TIMEOUT_MS` to change the setup timeout (default 5 minutes, separate from the research timeout).
- The same active model ID is passed to the worker. Autopilot does not silently switch models.

Hotcell workers have a narrow read-only tool profile, a per-worker spend cap, and a cleanup lifecycle. The Hotcell daemon owns provider credentials and injects its gateway token; Autopilot does not pass its OpenRouter key to the sandbox.

## Limits

Workers add model cost and latency. Defaults are $1 per worker, a $5 hard ceiling, a five-minute timeout, and at most three concurrent Hotcell cells. Configure limits with the environment variables KIMIFLARE_WORKER_BUDGET_USD, KIMIFLARE_WORKER_BUDGET_MAX_USD, KIMIFLARE_WORKER_TIMEOUT_MS, and KIMIFLARE_WORKER_MAX_PARALLEL. Each worker's cumulative input-token budget is derived from its spend cap and the model's input price (80% of the cap, clamped to 60k–3M tokens; 400k when the price is unknown); override it with KIMIFLARE_WORKER_MAX_INPUT_TOKENS. Workers end with a JSON report of cited findings, open questions, and files read, which the coordinator receives as structured results; an answer without a valid report is passed through and marked unverified.

Legacy workerEndpoint, workerApiKey, KIMIFLARE_WORKER_ENDPOINT, and KIMIFLARE_WORKER_BACKEND settings do not enable or route workers. The separate /remote command for interactive remote sessions is unaffected.

## If a worker cannot start

Autopilot reports Hotcell setup, repository, provider, and spend failures as tool errors. It does not silently fall back to a remote service. The coordinator can continue locally, but should not claim a worker ran when it did not.

For upstream design inspiration, see [Anthropic’s guide to when to use subagents](https://claude.com/blog/subagents-in-claude-code) and the [Claude Code subagents documentation](https://code.claude.com/docs/en/sub-agents).
