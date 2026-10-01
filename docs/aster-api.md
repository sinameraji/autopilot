# Aster API v1 and VM runbook

Aster is a native iOS client. Autopilot on the VM owns model credentials, prompts, tool execution, workspace roots, conversation history, approvals, and run lifecycle. The Aster API is a separate Bearer-authenticated control plane under `/api/v1`; it does not use the legacy `/prompt` or `/runs` contract.

## Security boundary

- Keep `autopilot serve` bound to `127.0.0.1:4096`. Do not open this port in Hetzner firewall/UFW and do not use Tailscale Funnel or a public reverse proxy.
- Development access uses an SSH local forward. Physical iPhone access requires a private tailnet (recommended: Tailscale Serve, not Funnel) plus an expiring, workspace-scoped Aster credential stored in the iOS Keychain. The current VM has no Tailscale installation/enrollment; Aster cannot reach it from a phone until the operator enrolls the VM and phone in the same tailnet.
- `/api/v1/*` requires `Authorization: Bearer aster_…`. Credentials are workspace-scoped, expire (default 30 days), are stored only as SHA-256 hashes, and can be revoked. Legacy routes keep their separate Basic auth.
- The API exposes only `read`, `write`, and `edit`; no shell, external job, browser, web, GitHub, or artifact-expansion tools. Reads/writes/edits resolve inside the conversation worktree, reject traversal/symlinks out of root, and block credential/VCS paths. `write` and `edit` require a per-action human approval.
- Provider credentials remain in the VM service environment/config. They are never sent to Aster or included in API responses/events. Provider-like secrets in turn text or proposed write arguments are rejected; assistant deltas are redacted defensively.

## Configure server-owned workspaces and models

Create `/etc/autopilot/aster.json` (do not put credentials in it):

```json
{
  "models": ["moonshotai/kimi-k2.6"],
  "approvalTtlMs": 300000,
  "workspaces": [
    {
      "id": "default",
      "displayName": "Default workspace",
      "rootPath": "/var/lib/autopilot/workspaces/default"
    }
  ]
}
```

`id` is the only workspace selector accepted from clients. The API never accepts a client-supplied cwd or filesystem path. Roots must be existing, non-overlapping directories; current implementation requires each selected workspace root to be a Git repository so a conversation can get its own worktree.

On the VM, provision the root for the dedicated service identity, seed an initial commit, and install the config as root-owned/read-only to the service:

```sh
sudo install -d -o autopilot -g autopilot -m 0700 /var/lib/autopilot/workspaces/default
sudo -u autopilot git -C /var/lib/autopilot/workspaces/default init --initial-branch=main
sudo -u autopilot git -C /var/lib/autopilot/workspaces/default config user.name "Autopilot"
sudo -u autopilot git -C /var/lib/autopilot/workspaces/default config user.email "autopilot@localhost"
printf '# Default workspace\n' | sudo -u autopilot tee /var/lib/autopilot/workspaces/default/README.md >/dev/null
sudo -u autopilot git -C /var/lib/autopilot/workspaces/default add README.md
sudo -u autopilot git -C /var/lib/autopilot/workspaces/default commit -m "Initialize workspace"
sudo chown root:autopilot /etc/autopilot
sudo chmod 0750 /etc/autopilot
sudo install -o root -g autopilot -m 0640 aster.json /etc/autopilot/aster.json
```

Set `AUTOPILOT_ASTER_CONFIG=/etc/autopilot/aster.json` in the existing `autopilot.service` `Environment=` entries, then `systemctl daemon-reload && systemctl restart autopilot`. Do not change `--hostname 127.0.0.1` or open a port.

## Issue/revoke the iPhone credential

Create credentials as the service user so the CLI and daemon share the same private database:

```sh
sudo -u autopilot env HOME=/var/lib/autopilot AUTOPILOT_ASTER_CONFIG=/etc/autopilot/aster.json \
  /usr/bin/node /opt/autopilot/bin/autopilot.mjs aster token create \
  --name "Aster iPhone" --workspace default
```

The token is printed once. Import it into the iOS Keychain; never commit it, put it in a prompt, or paste it into chat. Revoke immediately if the phone is lost:

```sh
sudo -u autopilot env HOME=/var/lib/autopilot \
  /usr/bin/node /opt/autopilot/bin/autopilot.mjs aster token revoke <credential-id>
```

## Access paths

Development over SSH (works now):

```sh
ssh -i ~/.ssh/google_compute_engine -N -L 4096:127.0.0.1:4096 root@2.29.49.61
```

Then use `http://127.0.0.1:4096` with the scoped Bearer token. For a physical iPhone, enroll both VM and phone in the same approved Tailscale tailnet, then use **Tailscale Serve only** to proxy HTTPS to `http://127.0.0.1:4096`. Do not enable Funnel or change Autopilot’s loopback bind. Enrollment requires the operator to complete Tailscale’s interactive device authorization; it is not done by this code change.

## API contract

All paths below require the scoped Bearer credential. Unknown IDs outside the token’s workspace scope are returned as `404` to avoid disclosing their existence. JSON errors use `{ "error": { "code": "...", "message": "..." } }`.

### Capabilities and discovery

`GET /api/v1/health`

```json
{
  "status": "ok",
  "service": "autopilot",
  "apiVersion": "v1",
  "serviceVersion": "1.5.0",
  "capabilities": ["workspaces", "conversations", "turns", "event-replay", "cancellation", "human-approvals"]
}
```

`GET /api/v1/workspaces` returns only configured, credential-scoped IDs and display names:

```json
{"workspaces":[{"id":"default","displayName":"Default workspace"}]}
```

`GET /api/v1/models` returns configured model IDs, never provider credentials.

### Conversations and turns

`POST /api/v1/conversations`

```json
{"workspaceId":"default","model":"moonshotai/kimi-k2.6"}
```

Returns `201` with an opaque conversation ID and cursor; no filesystem paths or agent history:

```json
{"conversationId":"<uuid>","workspaceId":"default","model":"moonshotai/kimi-k2.6","status":"ready","activeRunId":null,"lastEventId":1,"createdAt":"...","updatedAt":"..."}
```

`GET /api/v1/conversations/{conversationId}` resumes metadata by opaque ID. Conversation history remains server-side; Aster does not replay it on later requests.

`POST /api/v1/conversations/{conversationId}/turns`

```json
{"text":"Summarize the failing test and propose a fix."}
```

Returns `202` with `{conversationId,runId,status:"running"}`. Only one active turn per conversation is allowed; overlapping turns get `409 conversation_busy`. Text is capped at 20,000 characters; request bodies are capped at 64 KiB. Workspace and model cannot be changed by a turn request.

`POST /api/v1/conversations/{conversationId}/cancel` is idempotent. It aborts the active agent signal, updates durable run state, cancels pending approvals, and returns the current conversation.

### Events and reconnect

`GET /api/v1/conversations/{conversationId}/events` is SSE. Supply `Last-Event-ID: <sequence>` (or `?after=<sequence>`) to replay only later events. IDs are monotonic per conversation. Delivery is at-least-once: clients should de-duplicate by event ID. Reconnect with the last fully processed ID; replayed events are followed by live polling.

Example frames:

```text
id: 7
event: assistant.delta
data: {"delta":"I found the failing test."}

id: 8
event: tool.activity
data: {"tool":"edit","activity":"proposed"}

id: 9
event: approval.required
data: {"approvalId":"<uuid>","tool":"edit","explanation":"Edit src/example.ts in this workspace","expiresAt":...}

id: 10
event: usage
data: {"promptTokens":500,"completionTokens":40,"totalTokens":540,"costUsd":0.002}

id: 11
event: completed
data: {}
```

Tool events contain only names/status summaries, not raw arguments/results. Approval details are fetched separately after authentication. Terminal conversation states are `completed`, `failed`, `cancelled`, and `interrupted`; `waiting_approval` is nonterminal. On server restart, uncertain turns are marked interrupted and pending approvals expire; no action is replayed.

### Human approvals

`GET /api/v1/approvals/{approvalId}` returns the exact reviewable action/arguments and expiry. Secret-like payloads and paths outside the conversation worktree are rejected before an approval is created. The SSE `approval.required` event contains only the stable ID, tool name, concise explanation, and expiry.

`POST /api/v1/approvals/{approvalId}`

```json
{"decision":"allow"}
```

Use `deny` to reject. Decisions are single-use; repeating the same decision is idempotent, a conflicting decision returns `409 approval_already_resolved`, and expired approvals return `410 approval_expired`. Deny/expiry never execute the proposed tool action.

## Operations, retention, and rollback

- Service: `systemctl status autopilot`; logs: `journalctl -u autopilot`. Autopilot is a non-root systemd service with `Restart=on-failure`, loopback bind, and a health endpoint. Keep journald bounded (for example, an operator-approved `/etc/systemd/journald.conf.d/` cap); the current VM has no Autopilot-specific journald retention override.
- Before an upgrade, stop the service and make an offline backup of the Aster DB, run DB, sessions, worktrees, and workspace data. Encrypt the archive off-host with an operator-held `age` recipient; do not store a private decryption key on the VM.
- Roll back by stopping the service, checking out the previous known-good commit in `/opt/autopilot`, running `npm ci && npm run build`, and restarting. Keep the databases: schema changes are additive, and deleting them would lose conversations/approvals. Restore a backup only if the migration is incompatible, and restore the matching app version with it.
- The deployment smoke check must exercise create conversation, first turn, event replay, follow-up turn, approval resolution, and cancellation through an SSH tunnel. A one-turn health check alone is insufficient.

## Current operator setup gap

This runbook describes the required private path, but the inspected VM currently has no Tailscale client/enrollment. Until an operator enrolls the VM and iPhone into an approved tailnet and configures Serve (never Funnel), only the SSH-tunnel development path is available. Autopilot must remain loopback-bound in the meantime.
