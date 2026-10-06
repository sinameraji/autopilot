# Subagent policy and Jev checks

Regression matrix for the harness's delegation policy (`src/intent/subagent-policy.ts`) and the end-of-turn completion check (`src/agent/completion-check.ts`). Default policy is `auto`.

## Delegation guidance

| Request | Jev? | `subagent` tool offered? | Guidance |
|---|---:|---:|---|
| "What does this function do?" (light) | No | No | none — work locally |
| "Migrate the repository sequentially, one module at a time" | No | No | none — sequential wording wins |
| "Research these independent questions in parallel" | No | Yes | auto: delegate |
| "Use subagents to research the migration risks" | No | Yes | explicit delegate, whatever the policy |
| "Do not delegate; work sequentially" | No | No | explicit sequential; negative wins |
| Substantial request, policy `auto` | Yes, yes/no "two or more independent parts?", ≤3 s, in parallel with pre-turn work | Yes | strong "delegate these parts" at p ≥ 0.80, else the softer "assess and delegate if independent" |
| Substantial, research-flavoured request, policy `suggest` | Yes, choose delegate/sequential, ≤4 s | Only if p ≥ 0.65 | suggest |
| Jev timeout, error, malformed, custom endpoint, no OpenRouter key | Attempted at most once | As above | falls back to the default guidance; never blocks the turn |

Live spot checks (2026-10-04): "audit how auth, billing, and notifications each handle retries" → 0.93 (strong); "rename parseConfig and update its call sites" → 0.63 (soft). The 0.80 bar is deliberately high.

## Completion check

Runs when a turn ends with no tool calls, the intent tier is not light, and the final message is not a question. Question: did the turn end legitimately — completed, or a clearly explained blocker — rather than after only planning or announcing next steps? Below 0.20 the agent is told to continue, at most once per turn.

Live spot checks: plan-only stop 0.09 (nudged), finished feature 0.86, clearly explained blocker 0.94.

## Status

Unit tests cover the matrix, thresholds, redaction, timeouts, fallbacks, and once-per-turn nudging. Real-world precision and recall come from `/subagents stats` (delegation) and `turn:completion_nudge` log events (completion), not from these fixtures.
