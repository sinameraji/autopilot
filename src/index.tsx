import { Command, Option } from "commander";
import { loadConfig, DEFAULT_MODEL } from "./config.js";
import { resolveLspConfig } from "./util/lsp-config.js";
import { checkForUpdate } from "./util/update-check.js";
import type { UpdateCheckResult } from "./util/update-check.js";
import { getAppVersion } from "./util/version.js";
import { createRemoteCommand } from "./remote/cli.js";
import { renderLogo } from "./ui/logo.js";
import { runPrintMode } from "./print-mode.js";
import type { PrintFormat } from "./print-mode.js";

const program = new Command();
program
  .name("kimiflare")
  .description("Terminal coding agent. Runs any OpenRouter model with your own OpenRouter key (default: Kimi K2.6).")
  .version(getAppVersion())
  .option("-p, --print <prompt>", "one-shot mode: send prompt, stream reply to stdout, exit")
  .option("-m, --model <id>", `OpenRouter model id (defaults to ${DEFAULT_MODEL})`)
  // KimiFlare Cloud was retired with the move to OpenRouter. Keep the flag
  // parseable so old scripts don't break; it's ignored with a notice.
  .addOption(new Option("--cloud", "(retired) KimiFlare Cloud").hideHelp())
  .option("--dangerously-allow-all", "auto-approve every permission prompt (print mode only)")
  .option("--reasoning", "include reasoning in stdout (print mode only)")
  .option("--thinking", "alias for --reasoning")
  .option("--continue-on-limit", "reset tool-call counter and continue when the 200-call limit is hit (print mode only)")
  .option("--max-input-tokens <n>", "cumulative prompt token budget; exits 42 when exhausted (print mode only)", (v) => parseInt(v, 10))
  .option("--emit-events", "emit Camouflage NDJSON events to stdout; requires -p (for initial prompt)")
  .option("--multi-turn", "with --emit-events: keep reading stdin for UserInputSubmitted follow-ups after the initial turn")
  .option("--ui <name>", "render UI with React Ink (the only supported engine). This flag and KIMIFLARE_UI are currently ignored.")
  .option("--mode <mode>", "run mode: interactive (default), print, rpc")
  .option("-c, --continue", "continue the most recent session in the current working directory (print mode only)")
  .option("-S, --session <id>", "resume a specific session by id (print mode only)")
  .option("-f, --file <path>", "attach file(s) to the prompt; repeatable, supports globs (print mode only)", (v, prev: string[] | undefined) => (prev ?? []).concat(v))
  .option("--format <mode>", "output format for print mode: text (default), json, stream-json")
  .option("--dir <path>", "run in the specified directory instead of the current one (print mode only)")
  .option("--title <title>", "override the auto-generated session title (print mode only)")
  .option("--attach <url>", "attach to a running kimiflare serve instance (print mode only)");

program
  .command("cost")
  .description("Show cost attribution by task type (requires costAttribution enabled)")
  .option("-w, --week", "last 7 days (default)")
  .option("-m, --month", "last 30 days")
  .option("-d, --day", "today only")
  .option("-s, --session <id>", "single session detail")
  .option("-c, --category <name>", "filter by category")
  .option("--json", "machine-readable output")
  .option("--reclassify", "re-run classification on all sessions")
  .option("--local-only", "skip OpenRouter reconciliation (no network)")
  .action(async (cmdOpts) => {
    const cfg = await loadConfig();
    const enabled = cfg?.costAttribution ?? false;
    if (!enabled) {
      console.error(
        "Cost attribution is disabled. Enable it with:\n" +
          "  KIMI_COST_ATTRIBUTION=1 kimiflare cost\n" +
          "Or add costAttribution: true to ~/.config/kimiflare/config.json",
      );
      process.exit(1);
    }

    const { runCostCommand } = await import("./cost-attribution/cli.js");
    await runCostCommand({ ...cmdOpts, config: cfg });
  });

program.addCommand(createRemoteCommand());

const logsCmd = program
  .command("logs")
  .description("Inspect KimiFlare's structured logs (jsonl, one file per day, 7-day retention)");

logsCmd
  .command("path")
  .description("Print today's log file path. Useful for tailing: tail -f $(kimiflare logs path) | jq")
  .action(async () => {
    const { logPathFor } = await import("./util/log-sink.js");
    console.log(logPathFor());
  });

logsCmd
  .command("dir")
  .description("Print the log directory")
  .action(async () => {
    const { logDir } = await import("./util/log-sink.js");
    console.log(logDir());
  });

logsCmd
  .command("prune")
  .description("Delete log files older than 7 days")
  .action(async () => {
    const { pruneOldLogs } = await import("./util/log-sink.js");
    const removed = pruneOldLogs();
    console.log(`pruned ${removed} log files`);
  });

program
  .command("resume")
  .description("Resume is temporarily unavailable while Camouflage UI access is disabled.")
  .action(async () => {
    console.error("kimiflare resume: temporarily unavailable. Camouflage UI access is disabled.");
    process.exit(2);
  });

program
  .command("auth")
  .description("Authenticate with external services")
  .addCommand(
    new Command("openrouter")
      .description("Save your OpenRouter API key (validated first). For headless setups, OPENROUTER_API_KEY works too.")
      .argument("[key]", "the key (sk-or-…); omit to be prompted without echo")
      .action(async (keyArg: string | undefined) => {
        const { checkOpenRouterKey, looksLikeOpenRouterKey, OPENROUTER_KEYS_URL } = await import("./models/openrouter.js");
        const { patchPersistedConfig } = await import("./config.js");
        let key = keyArg?.trim();
        if (!key) {
          console.log(`Create a key at ${OPENROUTER_KEYS_URL}, then paste it here.`);
          key = (await promptHidden("OpenRouter API key: ")).trim();
        }
        if (!looksLikeOpenRouterKey(key)) {
          console.error("That doesn't look like an OpenRouter key — they start with sk-or-.");
          process.exit(1);
        }
        const res = await checkOpenRouterKey(key);
        if (!res.ok) {
          console.error(res.reason === "invalid" ? "OpenRouter rejected this key." : `Couldn't verify the key: ${res.message}`);
          process.exit(1);
        }
        const savedTo = await patchPersistedConfig({ openrouterApiKey: key });
        const credit = typeof res.info.limitRemaining === "number" ? ` · $${res.info.limitRemaining.toFixed(2)} credit left` : "";
        console.log(`✓ Key accepted${res.info.label ? ` (${res.info.label})` : ""}${credit}`);
        console.log(`Saved to ${savedTo}. Run \`kimiflare\` to start.`);
      }),
  )
  .addCommand(
    new Command("github")
      .description("Authenticate with GitHub via OAuth device flow")
      .action(async () => {
        const { authGitHubForTui } = await import("./remote/tui-auth.js");
        for await (const step of authGitHubForTui()) {
          console.log(step.message);
          if (step.url && step.code) {
            console.log(`\nOpen: ${step.url}`);
            console.log(`Code: ${step.code}\n`);
          }
          if (step.done) break;
          if (step.error) process.exit(1);
        }
      }),
  );

program
  .command("serve")
  .description("Start a headless HTTP server for API access and CI integration")
  .option("--port <n>", "port to listen on", (v) => parseInt(v, 10), 4096)
  .option("--hostname <host>", "hostname to listen on", "127.0.0.1")
  .action(async (cmdOpts) => {
    const cfg = await loadConfig();
    if (!cfg) {
      console.error("kimiflare serve: no OpenRouter API key — set OPENROUTER_API_KEY or run `kimiflare auth openrouter`.");
      process.exit(2);
    }
    const { ensureOpenRouterCatalog } = await import("./models/openrouter-catalog.js");
    await ensureOpenRouterCatalog();
    const { startServer } = await import("./server/index.js");
    await startServer({
      port: cmdOpts.port,
      hostname: cmdOpts.hostname,
      config: cfg,
    });
  });

program.action(async () => {
  await main();
});
program.parse();

const opts = program.opts<{
  print?: string;
  model?: string;
  cloud?: boolean;
  dangerouslyAllowAll?: boolean;
  reasoning?: boolean;
  thinking?: boolean;
  continueOnLimit?: boolean;
  maxInputTokens?: number;
  emitEvents?: boolean;
  multiTurn?: boolean;
  ui?: string;
  mode?: string;
  continue?: boolean;
  session?: string;
  file?: string[];
  format?: string;
  dir?: string;
  title?: string;
  attach?: string;
}>();

async function main() {
  // Initialize the OTLP/HTTP log exporter if `KIMIFLARE_OTEL_ENDPOINT`
  // is set. No-op otherwise — the env-var gate keeps this zero-cost for
  // users who don't care. Done before loadConfig so any early errors
  // ship too.
  const { initOtelSink, installOtelExitHook } = await import("./util/otel-sink.js");
  if (initOtelSink()) {
    installOtelExitHook();
  }

  const globalCfg = await loadConfig();
  const updateResult = await checkForUpdate();

  let cfg = globalCfg;
  let lspScope: "project" | "global" = "global";
  let lspProjectPath: string | null = null;

  if (globalCfg) {
    const resolved = await resolveLspConfig(globalCfg, process.cwd());
    cfg = {
      ...globalCfg,
      lspEnabled: resolved.lspEnabled,
      lspServers: resolved.lspServers,
    };
    lspScope = resolved.scope;
    lspProjectPath = resolved.projectPath;
  }

  // Load OpenRouter's model catalog (cache-first, 6h TTL; public endpoint, no
  // key needed) so context windows, pricing, capability gates and the model
  // picker reflect every model OpenRouter serves. Never blocks startup on a
  // network failure — the registry falls back to its seed list.
  const { ensureOpenRouterCatalog } = await import("./models/openrouter-catalog.js");
  await ensureOpenRouterCatalog();

  if (opts.cloud) {
    console.error("kimiflare: --cloud ignored — KimiFlare Cloud was retired; kimiflare now runs on your own OpenRouter key.");
  }

  if (opts.mode === "rpc") {
    const { startRpcServer } = await import("./sdk/rpc.js");
    await startRpcServer();
    return;
  }

  // (`--ui camouflage` is opt-in experimental; the camouflage branch lives at
  // the bottom of `main()` next to the Ink path so both share the TTY guard
  // + cfg checks. Default is `ink` until Camouflage covers every surface and
  // we've burned-in via opt-in dogfooding.)

  if (opts.emitEvents) {
    if (opts.print === undefined) {
      console.error(
        "kimiflare: --emit-events requires -p \"<prompt>\" (one-shot mode).\n" +
          "Multi-turn stdin-driven emit mode is not yet implemented.",
      );
      process.exit(2);
    }
    if (!cfg) {
      console.error("kimiflare: --emit-events requires credentials.");
      process.exit(2);
    }
    const model = opts.model ?? cfg.model ?? DEFAULT_MODEL;
    const { runEmitMode } = await import("./emit-mode.js");
    await runEmitMode({
      ...cfg,
      model,
      prompt: opts.print,
      allowAll: !!opts.dangerouslyAllowAll,
      multiTurn: !!opts.multiTurn,
      codeMode: cfg.codeMode,
      continueOnLimit: !!opts.continueOnLimit,
      maxInputTokens: opts.maxInputTokens,
    });
    return;
  }

  if (opts.print !== undefined) {
    if (!cfg) {
      console.error(
        "kimiflare: no OpenRouter API key configured.\n" +
          "Set OPENROUTER_API_KEY (create a key at https://openrouter.ai/keys), run\n" +
          "  kimiflare auth openrouter\n" +
          "or write it to ~/.config/kimiflare/config.json (chmod 600):\n" +
          `  { "openrouterApiKey": "sk-or-...", "model": "${DEFAULT_MODEL}" }`,
      );
      process.exit(2);
    }
    const model = opts.model ?? cfg.model ?? DEFAULT_MODEL;
    const format = (opts.format ?? "text") as PrintFormat;
    if (format !== "text" && format !== "json" && format !== "stream-json") {
      console.error(`kimiflare: invalid --format "${format}". Use: text, json, stream-json`);
      process.exit(2);
    }

    // Attach mode: connect to a running server
    if (opts.attach) {
      const { runAttachMode } = await import("./attach-mode.js");
      await runAttachMode({
        attachUrl: opts.attach,
        prompt: opts.print,
        model,
        files: opts.file,
        format,
        allowAll: !!opts.dangerouslyAllowAll,
        sessionId: opts.session,
      });
      return;
    }

    await runPrintMode({
      ...cfg,
      model,
      prompt: opts.print,
      allowAll: !!opts.dangerouslyAllowAll,
      showReasoning: !!(opts.reasoning || opts.thinking),
      codeMode: cfg.codeMode,
      continueOnLimit: !!opts.continueOnLimit,
      maxInputTokens: opts.maxInputTokens,
      updateResult,
      continueSession: !!opts.continue,
      sessionId: opts.session,
      files: opts.file,
      format,
      dir: opts.dir,
      title: opts.title,
      permissions: cfg.permissions,
    });
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "kimiflare: interactive mode requires a TTY. Use `kimiflare -p \"...\"` for non-TTY / piped usage.",
    );
    process.exit(2);
  }

  // ANSI logo. For the Ink path we still console.log it as part of the
  // pre-render output. For the Camouflage path we hand it to the
  // renderer as a Splash event so it stays visible until the user's
  // first prompt — console.log here would get swallowed by Camouflage's
  // alt-screen and flash for a fraction of a second.
  const logoText = renderLogo(getAppVersion(), opts.model ?? cfg?.model);

  // UI engine resolution: React Ink is always used. Camouflage UI access is
  // temporarily disabled, so `--ui`, `KIMIFLARE_UI`, and any persisted
  // `uiEngine: "camouflage"` config value are ignored.
  const uiEngine = "ink";
  console.log(logoText);
  // Camouflage UI branch is temporarily disabled.
  // if (uiEngine === "camouflage") {
  //   ...
  // }
  // React Ink UI.
  const { renderApp } = await import("./app.js");
  if (cfg) {
    const model = opts.model ?? cfg.model ?? DEFAULT_MODEL;
    await renderApp({ ...cfg, model }, updateResult, lspScope, lspProjectPath);
  } else {
    await renderApp(null, updateResult, lspScope, lspProjectPath);
  }
}





/** Read a line from the terminal without echoing it (for secrets). */
async function promptHidden(question: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  const { Writable } = await import("node:stream");
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}
