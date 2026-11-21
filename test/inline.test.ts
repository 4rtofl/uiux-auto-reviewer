import assert from "node:assert/strict";
import { test } from "node:test";
import { findingComment, findingIndex, hunks, placement } from "../src/inline.ts";
import { finding } from "./helpers.ts";

// New side: hunk 1 shows lines 3-6 (5 added), hunk 2 shows lines 20-22 (21 added).
const patch = [
  "@@ -3,3 +3,4 @@ function A() {",
  " const a = 1;",
  " const b = 2;",
  "+const c = 3;",
  " return a;",
  "@@ -18,3 +20,3 @@",
  " x();",
  "-old();",
  "+fresh();",
  " y();",
  "\\ No newline at end of file",
].join("\n");

test("hunks lists the new-side lines each hunk shows", () => {
  assert.deepEqual(hunks(patch).map((lines) => [...lines]), [
    [3, 4, 5, 6],
    [20, 21, 22],
  ]);
});

test("placement keeps a range one hunk shows, and narrows or drops the rest", () => {
  assert.deepEqual(placement(patch, 4, 6), { start_line: 4, line: 6 });
  assert.deepEqual(placement(patch, 5, 5), { line: 5 });
  // 5-12: only 5-6 are shown.
  assert.deepEqual(placement(patch, 5, 12), { start_line: 5, line: 6 });
  // 1-21: hunk 1 shows 3-6 (longer) and hunk 2 shows 20-21.
  assert.deepEqual(placement(patch, 1, 21), { start_line: 3, line: 6 });
  assert.equal(placement(patch, 10, 15), null);
  assert.equal(placement(undefined, 4, 4), null);
});

test("a finding's comment carries its index", () => {
  const body = findingComment(finding({ title: "@alice に確認がない" }), 2);
  assert.equal(findingIndex(body), 2);
  assert.match(body, /【重大・3】@​alice に確認がない/);
  assert.equal(findingIndex("ordinary comment"), null);
});
