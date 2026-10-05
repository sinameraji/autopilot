import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeGatewayBaseUrl } from "./aster-cell.js";

test("appends /v1 to the Hotcell gateway base URL exactly once", () => {
  assert.equal(normalizeGatewayBaseUrl("http://host.docker.internal:4752/openrouter"), "http://host.docker.internal:4752/openrouter/v1");
  assert.equal(normalizeGatewayBaseUrl("http://host.docker.internal:4752/openrouter/"), "http://host.docker.internal:4752/openrouter/v1");
  assert.equal(normalizeGatewayBaseUrl("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1");
  assert.equal(normalizeGatewayBaseUrl(undefined), undefined);
});
