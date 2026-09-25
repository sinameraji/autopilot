import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { fetchEmbeddings, cosineSimilarity, DEFAULT_EMBEDDING_MODEL } from "./embeddings.js";

function assertClose(actual: Float32Array, expected: number[], epsilon = 1e-6): void {
  assert.strictEqual(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    assert.ok(
      Math.abs(actual[i]! - expected[i]!) < epsilon,
      `expected ${actual[i]} to be close to ${expected[i]} at index ${i}`,
    );
  }
}

describe("fetchEmbeddings", () => {
  const originalFetch = globalThis.fetch;
  const savedBase = process.env.KIMIFLARE_BASE_URL;
  let lastRequest: Request | null = null;
  let responseBody: unknown = { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] };

  beforeEach(() => {
    delete process.env.KIMIFLARE_BASE_URL;
    lastRequest = null;
    responseBody = { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      lastRequest = new Request(input, init);
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedBase === undefined) delete process.env.KIMIFLARE_BASE_URL;
    else process.env.KIMIFLARE_BASE_URL = savedBase;
  });

  it("posts to OpenRouter /embeddings with the key and the same bge model Workers AI served", async () => {
    const vectors = await fetchEmbeddings({ openrouterApiKey: "sk-or-test", texts: ["hello world"] });
    assert.strictEqual(DEFAULT_EMBEDDING_MODEL, "baai/bge-base-en-v1.5");
    assert.strictEqual(lastRequest!.url, "https://openrouter.ai/api/v1/embeddings");
    assert.strictEqual(lastRequest!.headers.get("Authorization"), "Bearer sk-or-test");
    assert.deepStrictEqual(await lastRequest!.clone().json(), { model: "baai/bge-base-en-v1.5", input: ["hello world"] });
    assertClose(vectors[0]!, [0.1, 0.2, 0.3]);
  });

  it("batches texts and orders vectors by index, not arrival", async () => {
    responseBody = {
      data: [
        { index: 1, embedding: [0.4, 0.5, 0.6] },
        { index: 0, embedding: [0.1, 0.2, 0.3] },
      ],
    };
    const vectors = await fetchEmbeddings({ openrouterApiKey: "sk-or-test", texts: ["a", "b"] });
    assertClose(vectors[0]!, [0.1, 0.2, 0.3]);
    assertClose(vectors[1]!, [0.4, 0.5, 0.6]);
  });

  it("uses a custom endpoint's /embeddings when one is configured", async () => {
    await fetchEmbeddings({
      customEndpoint: { baseUrl: "https://broker.example/v1/", apiKey: "host-key" },
      texts: ["x"],
    });
    assert.strictEqual(lastRequest!.url, "https://broker.example/v1/embeddings");
    assert.strictEqual(lastRequest!.headers.get("Authorization"), "Bearer host-key");
  });

  it("throws without an OpenRouter key or custom endpoint", async () => {
    await assert.rejects(fetchEmbeddings({ texts: ["x"] }), /no OpenRouter API key/);
  });

  it("returns an empty array for empty input without calling the API", async () => {
    assert.deepStrictEqual(await fetchEmbeddings({ openrouterApiKey: "k", texts: [] }), []);
    assert.strictEqual(lastRequest, null);
  });

  it("throws when the response contains no vectors", async () => {
    responseBody = { data: [] };
    await assert.rejects(fetchEmbeddings({ openrouterApiKey: "k", texts: ["x"] }), /no vectors/);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    assert.strictEqual(cosineSimilarity(a, a), 1);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    assert.strictEqual(cosineSimilarity(a, b), 0);
  });

  it("returns 0 for mismatched dimensions", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0, 0]);
    assert.strictEqual(cosineSimilarity(a, b), 0);
  });
});
