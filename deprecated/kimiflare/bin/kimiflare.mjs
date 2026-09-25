#!/usr/bin/env node
// kimiflare was renamed to autopilot (npm package: autopilot-ai). This final
// kimiflare release keeps the old command working by forwarding to it, and
// tells the user how to switch. Written to stderr so `kimiflare -p` output
// piped from stdout stays clean.
const yellow = "\x1b[33m";
const bold = "\x1b[1m";
const reset = "\x1b[0m";
process.stderr.write(
  `${yellow}${bold}kimiflare has been renamed to autopilot.${reset}\n` +
    `${yellow}  Switch with:  npm uninstall -g kimiflare && npm install -g autopilot-ai${reset}\n` +
    `${yellow}  Then run:     autopilot   (your settings, sessions and memory carry over)${reset}\n\n`,
);
await import("autopilot-ai");
