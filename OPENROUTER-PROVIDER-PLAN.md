# Plan: OpenRouter as a provider + free model choice

Written by the ops agent, 2026-09-19, after reading the codebase and commit history. Nothing in
this doc has been implemented yet — this is the plan for review before any code changes.

## What this repo is today

KimiFlare (currently at `github.com/sinameraji/autopilot`, `package.json` name still
`kimiflare`, previously `camouflage` — see `CAMOUFLAGE_MIGRATION.md` for that precedent) is a
terminal coding agent whose entire identity is built around Cloudflare:

- Onboarding is **Log in with Cloudflare** (OAuth) or a pasted API token; there is no path that
  skips Cloudflare entirely from the wizard.
- Model calls go through one of three routes, all Cloudflare (`src/models/registry.ts`
  `routeFor()`): direct **Workers AI** (`api.cloudflare.com/.../ai/run/{model}`), the
  **Cloudflare model catalog** for third-party models like Kimi K3
  (`.../ai/v1/chat/completions`), or the **AI Gateway Universal Endpoint** for everything else
  (Anthropic/OpenAI/Google), with Cloudflare's Unified Billing or BYOK.
- The model list is a **hardcoded array** (`SEED` in `registry.ts`): 4 Kimi models + 1 GLM model,
  all Workers-AI or CF-catalog. Nothing outside that list is chosen through the UI; an unknown
  model id falls back to generic, conservative capability guesses (`getModelOrInfer`).
- Cost tracking, the `/cost` command, and the "estimate → gateway-confirmed" UX all read from
  Cloudflare's AI Gateway logs API — this is Cloudflare-specific end to end.
- There's a `feedback-worker` and other Cloudflare Pages/Workers infra outside `src/`.

**One important head start:** a custom-endpoint escape hatch already exists
(`KIMIFLARE_BASE_URL` / `KIMIFLARE_API_KEY`, added Aug 20 by Sina + Claude, commits `93ef6ce`
through `ba9ff81`). It sends every request to `<baseUrl>/chat/completions` with a bearer token,
bypassing all Cloudflare paths. **This is not the right vehicle for the feature below** — its own
doc comment says it's for a *host application* embedding kimiflare and owning its own broker. Used
as the OpenRouter path it would give every OpenRouter model the same generic 128k/no-reasoning
defaults, no real model picker, no per-model pricing, and no cost tracking — a visibly worse
experience than what Cloudflare users get today. It's still useful as a reference for the request
plumbing, and for local/offline testing against a mock endpoint.

## Scope decision I need from you before I start building

Two different sizes of project are hiding inside "migrate the provider":

**A — Add OpenRouter as a provider option, Cloudflare stays.** Users pick a provider at
onboarding (or later via a command); everyone who already has Cloudflare set up keeps working
exactly as today. Additive, non-breaking, no rename required to ship it. This is what the rest of
this plan builds.

**B — Replace Cloudflare as the primary/only provider.** Touches the OAuth login flow, the
Unified Billing messaging throughout the README and onboarding copy, `feedback-worker` and any
other Cloudflare Pages/Workers infra, and is a breaking change for existing installs. Given the
project is also being renamed to `autopilot`, this might be the actual destination — but it's a
materially bigger job (weeks, not days) and touches branding/docs/marketing surfaces (the demos,
the docs site) beyond code, not just `src/`.

**My recommendation:** build A first regardless of the eventual answer — B needs A's transport and
model-catalog work as a foundation anyway, and A alone already delivers what you described (any
OpenRouter model, chosen freely). Decide B once A is real and you've used it. Flag in your review
if you actually want B started now instead.

## Plan (scope A)

### 1. First-class OpenRouter route (not the custom-endpoint escape hatch)

- Add `"openrouter"` to `ModelProvider` (`src/models/registry.ts`).
- New branch in `buildKimiRequestTarget()` (`src/agent/client.ts`), parallel to the existing
  `workers-ai` / `cf-catalog` / `gateway` branches: `POST
  https://openrouter.ai/api/v1/chat/completions`, `Authorization: Bearer <key>`, plus OpenRouter's
  recommended attribution headers (`HTTP-Referer`, `X-Title` — cheap, and it's how projects show
  up in OpenRouter's public rankings). OpenRouter's wire format is standard OpenAI-compatible
  chat-completions with SSE streaming, which is very likely close enough to the existing `gateway`
  branch's parsing that most of the stream-handling code is reusable as-is — need to confirm no
  Cloudflare-specific response wrapping is assumed there before assuming a clean reuse.
- `routeFor()` gets a fourth branch for `"openrouter"`; `isUnifiedEligible()` returns `false` for
  it (OpenRouter has no Cloudflare-style unified billing — it's the user's own OpenRouter key,
  full stop, which is actually a simpler mental model than the current three-tier CF logic).

### 2. Dynamic model catalog instead of a hardcoded list

`GET https://openrouter.ai/api/v1/models` is public (no auth needed to list) and returns every
model OpenRouter serves: id, `context_length`, `pricing.prompt` / `pricing.completion` (per
token), and `supported_parameters` (which reveals tool-calling support, whether `temperature` is
accepted, etc. — the same shape `ModelCapabilities` already wants).

- Fetch + cache this list (e.g. `~/.kimiflare/openrouter-models.json`, TTL-based refresh, fall
  back to the stale cache on a failed fetch so a network blip doesn't break the picker).
- Map each entry into `ModelEntry` and merge into `listModels()` — this is the literal mechanism
  for "let users pick any model available on OpenRouter": the picker becomes a live, complete list
  instead of a maintained-by-hand array, and it stays current as OpenRouter adds or removes
  models with zero code changes here.
- Free/very-cheap models (there are several genuinely free ones on OpenRouter) are worth
  surfacing distinctly in the picker — good default for people who don't want to think about cost
  yet.

### 3. Cost tracking

OpenRouter's `GET /api/v1/generation?id=<id>` returns authoritative per-generation cost after the
fact — the same shape of "fast local estimate, then a confirmed real number" the product already
does for Cloudflare's AI Gateway logs. Plan to reuse that UX pattern (`/cost`, the status-bar
estimate-then-confirm) rather than inventing a new one, so this feels like the same product rather
than a bolted-on second system.

### 4. Onboarding

Today's wizard is Cloudflare-OAuth-first with no early exit. Needs a fork near the start:
"Connect Cloudflare" vs "Use OpenRouter." OpenRouter's own keys (`sk-or-...`) are plain bearer
tokens with no account-id/OAuth dance required, so a paste-your-key step is a complete, honest MVP
here — meaningfully simpler than the Cloudflare flow it sits next to, so this half of the work is
smaller than it might sound. (OpenRouter does also support a PKCE-style OAuth key-provisioning
flow if a "no key copy-paste at all" experience is wanted later, matching the polish level of
today's Cloudflare login — worth a fast-follow, not blocking the first ship.)

### 5. Testing — the part you specifically flagged

You're right that a terminal agent is easy to quietly break: a change to routing or model
selection can silently change what actually gets sent to the model, or what a tool call round-trip
looks like, without any test failing. Concretely:

- Unit tests for the new pure logic (URL building, model-list mapping, capability inference),
  following the existing pattern (`config.test.ts`, `permissions-evaluator.test.ts`,
  `models/registry.test.ts`), run via the existing `npm test` (Node's built-in test runner via
  `tsx --test`).
- A small **golden-transcript smoke test**: a couple of fixed prompts sent through the real
  OpenRouter path against a free/cheap model, asserting the response has the expected shape (tool
  call round-trips correctly, streamed text is non-empty, no silently-swallowed error) — this is
  the literal "does the prompt the harness sends match the output it gives back" check you asked
  for, scoped small enough to run in CI without real spend beyond a free-tier model.
- Before this branch is proposed for merge: a manual pass actually running the TUI against
  OpenRouter end-to-end (not just unit tests), the same way the `demos/*.tape` recordings imply
  this project already verifies real terminal behavior before release.

### Sequencing

1. This plan doc (this PR) — your review first, before any code.
2. Registry + routing (§1, §2) — the transport and model list, no UI yet; testable headless via
   the SDK / RPC mode that already exists.
3. Onboarding fork (§4).
4. Cost tracking (§3).
5. Tests throughout, not bolted on at the end (§5).

Each of 2–5 as its own branch and PR, in that order, so review stays small per step rather than one
large diff.

## Open questions for you

1. Scope A vs B (above) — confirm A first, or you want B started now?
2. Keep the `kimiflare` name for the npm package for now, or is the rename to `autopilot`
   happening in parallel with this work? (Affects whether I touch `package.json`'s `name`/`bin`/
   repo URLs as part of this, or leave that for a separate rename PR mirroring
   `CAMOUFLAGE_MIGRATION.md`'s playbook.)
3. Should the existing Cloudflare-only users see anything change in this phase, or should this be
   fully invisible to them until they explicitly opt into OpenRouter?
