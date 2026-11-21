import assert from "node:assert/strict";
import { test } from "node:test";
import { configFromText, DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { reviewedMarker, reviewedSha, stillHolds } from "../src/reuse.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";

test("the reviewed head round-trips through the comment", () => {
  assert.equal(reviewedSha(`## 🎨 UI/UX レビュー\n\n…\n${reviewedMarker(sha)}`), sha);
  assert.equal(reviewedSha("<!-- uiux-auto-reviewer -->"), null);
  assert.equal(reviewedSha(undefined), null);
});

test("a result holds while no reviewed file changes", () => {
  const config = parseConfig({ paths: ["apps/web/src/**/*.tsx"] }, "c.json");
  assert.equal(stillHolds(["apps/hub/src/a.ts", "README.md"], config), true);
  assert.equal(stillHolds([], config), true);
  assert.equal(stillHolds(["apps/web/src/b.tsx"], config), false);
  assert.equal(stillHolds(null, config), false);
});

test("the settings fall back to the defaults when the base has none", () => {
  assert.equal(configFromText(null, "c.json"), DEFAULT_CONFIG);
  assert.deepEqual(configFromText('{"paths":["x/**"]}', "c.json").paths, ["x/**"]);
  assert.throws(() => configFromText("{", "c.json at main"), /c\.json at main: not valid JSON/);
});
