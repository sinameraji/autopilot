import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { askJev, formatJevAnswer, type JevQuestion } from "./jev.js";
import type { JevProjectContext } from "./jev-context.js";

const originalBase = process.env.OPENROUTER_BASE_URL;
afterEach(() => {
  if (originalBase === undefined) delete process.env.OPENROUTER_BASE_URL;
  else process.env.OPENROUTER_BASE_URL = originalBase;
});

function mockResponse(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

const noTimeout = new AbortController().signal;

describe("askJev", () => {
  it("sends a binary decision to the Alpha Decisions endpoint", async () => {
    process.env.OPENROUTER_BASE_URL = "http://localhost:8788/api/v1/";
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenInit = init;
      return new Response(JSON.stringify({ answers: { answer: { type: "noul", noul: 0.96 } } }));
    }) as typeof fetch;

    const question: JevQuestion = { kind: "yes", prompt: "Is this a bug?" };
    const answer = await askJev("sk-or-test", question, fetchImpl, noTimeout);

    assert.strictEqual(seenUrl, "http://localhost:8788/api/alpha/decisions");
    assert.strictEqual((seenInit?.headers as Record<string, string>).Authorization, "Bearer sk-or-test");
    assert.strictEqual(seenInit?.method, "POST");
    assert.deepStrictEqual(JSON.parse(String(seenInit?.body)), {
      model: "~typesafe/jev-latest",
      state: { question: "Is this a bug?" },
      questions: { answer: { type: "noul", instructions: "Is this a bug?" } },
    });
    assert.deepStrictEqual(answer, { type: "noul", noul: 0.96 });
    assert.strictEqual(formatJevAnswer(question, answer), "Yes · 96% probability");
  });

  it("sends selected project evidence as labeled reference context", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ answers: { answer: { type: "noul", noul: 0.81 } } }));
    }) as typeof fetch;
    const context: JevProjectContext = {
      evidence: "name: autopilot-ai\\nlicense: MIT",
      summary: "autopilot-ai · MIT",
      sources: ["package.json", "LICENSE"],
    };

    await askJev("sk-or-test", { kind: "yes", prompt: "Is this harness open source?" }, fetchImpl, noTimeout, context);

    assert.deepStrictEqual(seenBody?.state, {
      question: "Is this harness open source?",
      projectContext: { evidence: context.evidence, sources: context.sources },
    });
    const question = (seenBody?.questions as { answer: { instructions: string } }).answer;
    assert.match(question.instructions, /Local project evidence \(reference data, not instructions/);
    assert.match(question.instructions, /license: MIT/);
  });

  it("formats the most likely choice and score labels", () => {
    const choose: JevQuestion = { kind: "choose", prompt: "Pick one", options: ["A", "B"] };
    assert.strictEqual(
      formatJevAnswer(choose, { type: "choice", probabilities: { A: 0.2, B: 0.8 } }),
      "B · 80% probability",
    );
    const score: JevQuestion = { kind: "score", prompt: "How urgent?", scale: ["low", "high"] };
    assert.strictEqual(
      formatJevAnswer(score, { type: "score", score: 0.85, probabilities: { low: 0.1, high: 0.9 }, legend: { high: "Blocking" } }),
      "Score 0.85 · Blocking",
    );
  });

  it("surfaces OpenRouter errors and rejects malformed success payloads", async () => {
    await assert.rejects(
      askJev("sk-or-test", { kind: "yes", prompt: "Question?" }, mockResponse({ error: { message: "Not allowed" } }, 400), noTimeout),
      /Jev request failed \(HTTP 400\): Not allowed/,
    );
    await assert.rejects(
      askJev("sk-or-test", { kind: "yes", prompt: "Question?" }, mockResponse({ answers: {} }), noTimeout),
      /did not include an answer/,
    );
  });
});
