import { Command } from "commander";
import { loadConfig, saveConfig } from "../config.js";
import {
  listRemoteSessions,
  loadRemoteSession,
  getMostRecentRemoteSession,
} from "./session-store.js";
import { runDeploy, checkDeployStatus } from "./deploy.js";

export function createRemoteCommand(): Command {
  const remote = new Command("remote").description("Manage remote sessions");

  remote
    .command("deploy")
    .description("Deploy the remote Worker and container image to Cloudflare")
    .action(async () => {
      await runDeploy();
    });

  remote
    .command("setup")
    .description("Check remote deployment status and prerequisites")
    .action(async () => {
      const status = await checkDeployStatus();
      console.log("Remote deployment status:\n");
      console.log(`  wrangler CLI:    ${status.wrangler ? "yes" : "no"}`);
      console.log(`  wrangler auth:   ${status.wranglerAuth ? "yes" : "no"}`);
      console.log(`  Docker:          ${status.docker ? "yes" : "no"}`);
      console.log(`  Worker URL:      ${status.workerUrl ?? "not deployed"}`);
      console.log("\nRun `autopilot remote deploy` to deploy.");
    });

  remote
    .command("list")
    .description("List remote sessions")
    .action(async () => {
      const sessions = await listRemoteSessions();
      if (sessions.length === 0) {
        console.log("No remote sessions found.");
        return;
      }
      console.log(`Remote sessions (${sessions.length} total):\n`);
      for (const s of sessions.slice(0, 20)) {
        const date = new Date(s.createdAt).toLocaleString();
        const statusIcon = s.status === "done" ? "✅" : s.status === "error" ? "❌" : s.status === "running" ? "⏳" : "⏹️";
        console.log(`  ${statusIcon} ${s.sessionId.slice(0, 8)}…  ${s.status.padEnd(10)}  ${date}  ${s.prompt.slice(0, 50)}`);
        if (s.prUrl) {
          console.log(`     PR: ${s.prUrl}`);
        }
      }
    });

  remote
    .command("status")
    .description("Show remote session status")
    .argument("[session-id]", "Session ID (defaults to most recent)")
    .action(async (sessionId?: string) => {
      const session = sessionId
        ? await loadRemoteSession(sessionId)
        : await getMostRecentRemoteSession();

      if (!session) {
        console.log(sessionId ? `Session ${sessionId} not found.` : "No remote sessions found.");
        return;
      }

      const cfg = await loadConfig();
      const workerUrl = cfg?.remoteWorkerUrl;
      if (!workerUrl) {
        console.log("Remote worker not configured.");
        return;
      }

      try {
        const res = await fetch(`${workerUrl}/remote/status/${session.sessionId}`, {
          headers: {
            Authorization: `Bearer ${cfg.remoteAuthSecret ?? ""}`,
          },
        });
        if (!res.ok) {
          console.log(`Failed to fetch status: ${res.status}`);
          return;
        }
        const data = await res.json();
        console.log(`Session: ${data.sessionId}`);
        console.log(`Status:  ${data.status}`);
        console.log(`Prompt:  ${data.prompt}`);
        console.log(`Repo:    ${data.repo?.owner}/${data.repo?.name}`);
        console.log(`Branch:  ${data.branch}`);
        console.log(`Turns:   ${data.currentTurn} / ${data.maxTurns}`);
        if (data.prUrl) console.log(`PR:      ${data.prUrl}`);
        if (data.errorMessage) console.log(`Error:   ${data.errorMessage}`);
      } catch (err) {
        console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  remote
    .command("cancel")
    .description("Cancel a remote session")
    .argument("<session-id>", "Session ID")
    .action(async (sessionId: string) => {
      const cfg = await loadConfig();
      const workerUrl = cfg?.remoteWorkerUrl;
      if (!workerUrl) {
        console.log("Remote worker not configured.");
        return;
      }

      try {
        const res = await fetch(`${workerUrl}/remote/cancel/${sessionId}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cfg.remoteAuthSecret ?? ""}`,
          },
        });
        if (!res.ok) {
          console.log(`Failed to cancel: ${res.status}`);
          return;
        }
        console.log(`Session ${sessionId} cancelled.`);
      } catch (err) {
        console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  return remote;
}
