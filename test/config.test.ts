import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, isReviewed, parseConfig } from "../src/config.ts";

test("defaults apply to missing keys", () => {
  const config = parseConfig({ paths: ["apps/web/src/**"] }, "c.json");
  assert.deepEqual(config.paths, ["apps/web/src/**"]);
  assert.equal(config.maxInputChars, DEFAULT_CONFIG.maxInputChars);
  assert.equal(config.taste, null);
});

test("unknown keys and wrong types are rejected", () => {
  assert.throws(() => parseConfig({ path: [] }, "c.json"), /unknown key "path"/);
  assert.throws(() => parseConfig({ paths: "src/**" }, "c.json"), /array of strings/);
  assert.throws(() => parseConfig({ maxIssues: -1 }, "c.json"), /non-negative integer/);
  assert.throws(() => parseConfig([], "c.json"), /object/);
});

test("paths select and exclude removes", () => {
  const config = parseConfig({ paths: ["apps/web/src/**"], exclude: ["**/*.test.tsx"] }, "c.json");
  assert.equal(isReviewed("apps/web/src/components/a.tsx", config), true);
  assert.equal(isReviewed("apps/web/src/components/a.test.tsx", config), false);
  assert.equal(isReviewed("apps/hub/src/a.ts", config), false);
});
