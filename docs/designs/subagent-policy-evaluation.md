# Subagent policy evaluation fixtures

This is a regression matrix for the harness policy, not a claim that Jev has been empirically calibrated. The default remains `suggest`; `auto` is opt-in until real-world false-positive, false-negative, latency, and cost data are collected.

| Fixture | Expected effort/shape | Jev? | Worker tool available? | Expected behavior |
|---|---|---:|---:|---|
| “What does this function do?” | Light, one question | No | No | Answer locally |
| “Fix the typo in `src/one-file.ts`” | Light, one-file change | No | No | Work locally |
| “Migrate the repository sequentially, one module at a time” | Heavy, explicitly dependent | No | No | Preserve the stated order |
| “Research these independent questions in parallel” | Independent work is explicit | No | Yes, permission-gated | Coordinator may spawn bounded missions and synthesize |
| “Audit the codebase for vulnerabilities” | Heavy, parallelizability ambiguous | Yes, if OpenRouter is available | Only after a positive suggestion/auto decision | `suggest` at probability ≥0.65; `auto` dispatch guidance at ≥0.80; otherwise stay local |
| “Use subagents to research the migration risks” | Explicit user delegation | No | Yes, permission-gated | Respect explicit request regardless of automatic policy |
| “Do not delegate; work sequentially” | Explicit user preference | No | No | Work locally; negative instruction wins over any positive phrase |
| Jev timeout, malformed choice, or unavailable provider | Ambiguous candidate, advice unavailable | Attempted at most once, ≤4 seconds | No | Fail closed to local sequential work |

The unit suite covers this matrix, the `0.65`/`0.80` thresholds, bounded/redacted task text, cancellation, unavailable Jev, custom endpoints, and the executor-side rejection of unadvertised tools. A worker is never launched by the policy function: `spawn_worker` is exposed only for an explicit request, a suggestion candidate, or a high-confidence opt-in `auto` decision, and every invocation still goes through the normal permission flow and configured provider/spend/concurrency/timeout restrictions.

## Evaluation status

- Regression fixtures: covered by `src/intent/subagent-policy.test.ts` and `src/agent/loop.test.ts`.
- Live Jev quality/precision/recall: not yet measured; mocked typed responses validate handling, not decision quality.
- Worker cost/latency: bounded by existing worker configuration and the per-cell spend cap; production distributions have not yet been measured.
- Rollout: default `suggest`; automatic dispatch remains explicit opt-in with `/subagents auto` or `KIMIFLARE_SUBAGENT_POLICY=auto`.
