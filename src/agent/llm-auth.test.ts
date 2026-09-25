import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { hasLlmAuth, llmAuthFromConfig } from "./llm-auth.js";

describe("llmAuthFromConfig", () => {
  const saved = { base: process.env.KIMIFLARE_BASE_URL, key: process.env.KIMIFLARE_API_KEY };
  beforeEach(() => {
    delete process.env.KIMIFLARE_BASE_URL;
    delete process.env.KIMIFLARE_API_KEY;
  });
  afterEach(() => {
    if (saved.base === undefined) delete process.env.KIMIFLARE_BASE_URL;
    else process.env.KIMIFLARE_BASE_URL = saved.base;
    if (saved.key === undefined) delete process.env.KIMIFLARE_API_KEY;
    else process.env.KIMIFLARE_API_KEY = saved.key;
  });

  it("carries just the OpenRouter key for a normal config", () => {
    assert.deepStrictEqual(llmAuthFromConfig({ openrouterApiKey: "sk-or-a" }), { openrouterApiKey: "sk-or-a" });
  });

  it("resolves a custom endpoint from the config file, not only the env", () => {
    const auth = llmAuthFromConfig({ baseUrl: "https://broker.example/v1", apiKey: "host" });
    assert.deepStrictEqual(auth.customEndpoint, { baseUrl: "https://broker.example/v1", apiKey: "host" });
  });

  it("lets KIMIFLARE_BASE_URL win over the config file", () => {
    process.env.KIMIFLARE_BASE_URL = "https://env.example/v1";
    assert.strictEqual(llmAuthFromConfig({ baseUrl: "https://file.example/v1" }).customEndpoint?.baseUrl, "https://env.example/v1");
  });

  it("passes provider routing preferences through", () => {
    assert.deepStrictEqual(llmAuthFromConfig({ openrouterApiKey: "k", openrouterProvider: { ignore: ["X"] } }).provider, { ignore: ["X"] });
  });

  it("is empty for a null config", () => {
    assert.deepStrictEqual(llmAuthFromConfig(null), {});
  });
});

describe("hasLlmAuth", () => {
  it("needs a key or a custom endpoint", () => {
    assert.strictEqual(hasLlmAuth({}), false);
    assert.strictEqual(hasLlmAuth({ openrouterApiKey: "k" }), true);
    assert.strictEqual(hasLlmAuth({ customEndpoint: { baseUrl: "http://x" } }), true);
  });
});
