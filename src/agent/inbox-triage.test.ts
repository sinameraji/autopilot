import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planTriageAction, steerMessage, triageByRules, triageIncoming, type TriageResult } from "./inbox-triage.js";
import type { JevAnswer } from "./jev.js";

const ctx = { currentTask: "Refactor the auth module", activity: "tools: edit" };
const choice = (probabilities: Record<string, number>): JevAnswer => ({ type: "choice", probabilities } as JevAnswer);

describe("triageByRules", () => {
  const cases: Array<[string, TriageResult["kind"] | null]> = [
    ["stop, that's the wrong file", "interrupt"],
    ["wait", "interrupt"],
    ["No.", "interrupt"],
    ["that's not what I meant", "interrupt"],
    ["don't touch the tests", "interrupt"],
    ["wait until the build finishes, then deploy", null],
    ["no need to add tests", null],
    ["also handle the empty case", "steer"],
    ["use pnpm instead of npm", "steer"],
    ["make sure it works on Windows", "steer"],
    ["after this, update the changelog", "queue"],
    ["when you're done, open a PR", "queue"],
    ["/model", "queue"],
    ["!ls", "queue"],
    ["how's it going?", "aside"],
    ["what are you working on", "aside"],
    ["write a blog post about our release", null],
  ];
  for (const [text, kind] of cases) {
    it(`${JSON.stringify(text)} → ${kind ?? "undecided"}`, () => {
      assert.equal(triageByRules(text)?.kind ?? null, kind);
    });
  }
});

describe("triageIncoming", () => {
  it("decides clear cases without a model call", async () => {
    let calls = 0;
    const result = await triageIncoming("also add logging", ctx, { apiKey: "k", ask: async () => { calls++; return choice({}); } });
    assert.equal(result.kind, "steer");
    assert.equal(result.source, "rule");
    assert.equal(calls, 0);
  });

  it("uses the model for ambiguous messages and acts on confident answers", async () => {
    let prompt = "";
    const result = await triageIncoming("the token refresh should go through the cache layer", ctx, {
      apiKey: "k",
      ask: async (_key, question) => {
        prompt = question.prompt;
        return choice({ interrupt: 0.05, steer: 0.8, queue: 0.1, aside: 0.05 });
      },
    });
    assert.deepEqual([result.kind, result.source], ["steer", "model"]);
    assert.match(prompt, /Current task: Refactor the auth module/);
    assert.match(prompt, /New message: the token refresh/);
  });

  it("queues when the model is unsure, unavailable, or not configured", async () => {
    const low = await triageIncoming("hmm the cache", ctx, { apiKey: "k", ask: async () => choice({ interrupt: 0.45, steer: 0.3, queue: 0.2, aside: 0.05 }) });
    assert.deepEqual([low.kind, low.source], ["queue", "default"]);
    assert.match(low.reason, /leaned interrupt at 45%/);
    const failing = await triageIncoming("hmm the cache", ctx, { apiKey: "k", ask: async () => { throw new Error("timeout"); } });
    assert.deepEqual([failing.kind, failing.source], ["queue", "default"]);
    let calls = 0;
    const custom = await triageIncoming("hmm", ctx, { apiKey: "k", customEndpoint: true, ask: async () => { calls++; return choice({ steer: 1 }); } });
    assert.equal(custom.kind, "queue");
    assert.equal(calls, 0);
    assert.equal((await triageIncoming("hmm", ctx, {})).kind, "queue");
  });
});

describe("planTriageAction", () => {
  const r = (kind: TriageResult["kind"], source: TriageResult["source"] = "rule"): TriageResult => ({ kind, source, reason: "r" });
  const busy = { busy: true, subagentsRunning: false };

  it("leaves everything queued once the turn has ended", () => {
    for (const kind of ["interrupt", "steer", "aside", "queue"] as const) {
      assert.equal(planTriageAction(r(kind), { busy: false, subagentsRunning: false }).do, "keep-queued");
    }
  });

  it("maps each kind while the agent is busy", () => {
    assert.deepEqual(planTriageAction(r("queue", "default"), busy), { do: "keep-queued", note: "queued (unsure)" });
    assert.equal(planTriageAction(r("aside"), busy).do, "aside");
    assert.equal(planTriageAction(r("interrupt"), busy).do, "interrupt");
    const steer = planTriageAction(r("steer"), busy);
    assert.equal(steer.do === "steer" && steer.urgent, false);
  });

  it("never interrupts while subagents run; delivers urgently instead", () => {
    const action = planTriageAction(r("interrupt"), { busy: true, subagentsRunning: true });
    assert.equal(action.do, "steer");
    assert.ok(action.do === "steer" && action.urgent && /\/subagents cancel/.test(action.note));
  });

  it("runs a promoted (Ctrl+G) message first", () => {
    const action = planTriageAction(r("queue", "default"), { ...busy, promoted: true });
    assert.ok(action.do === "steer" && action.urgent);
  });

  it("labels steer messages so the model knows they arrived mid-task", () => {
    assert.match(steerMessage("also X"), /^\[Message from the user while you were working/);
    assert.match(steerMessage("do X", true), /^\[The user asked to handle this before continuing/);
  });
});
