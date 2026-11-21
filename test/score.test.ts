import assert from "node:assert/strict";
import { test } from "node:test";
import { axisScore, filterFindings, score } from "../src/score.ts";
import { finding } from "./helpers.ts";

const reviewed = new Map([["src/a.tsx", 10]]);

test("findings without a real place, unsure ones and severity 0 are dropped", () => {
  const { kept, dropped } = filterFindings(
    [
      finding(),
      finding({ file: "src/other.tsx" }),
      finding({ line: 11 }),
      finding({ confidence: "low" }),
      finding({ severity: 0 }),
      finding({ evidence: "  " }),
    ],
    reviewed,
  );
  assert.equal(kept.length, 1);
  assert.deepEqual(
    dropped.map((item) => item.reason),
    ["レビュー対象外のファイル", "行番号がファイルの範囲外", "確信度が低い", "深刻度 0（問題ではない）", "根拠がない"],
  );
});

test("end_line is clamped into the file", () => {
  const { kept } = filterFindings([finding({ line: 9, end_line: 40 }), finding({ line: 5, end_line: 2 })], reviewed);
  assert.deepEqual(
    kept.map((item) => [item.line, item.end_line]),
    [[5, 5], [9, 10]],
  );
});

test("axis scores follow the worst severity", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(axisScore), [3, 2, 2, 1, 0]);
});

test("the total covers applicable axes only, and an axis with findings counts as applicable", () => {
  const scored = score(
    {
      summary: "",
      axes: [
        { axis: "errors", applicable: true, note: "" },
        { axis: "copy", applicable: true, note: "" },
        { axis: "a11y", applicable: false, note: "" },
      ],
      findings: [finding({ severity: 4 }), finding({ axis: "a11y", severity: 2, line: 1 })],
    },
    reviewed,
  );
  const byAxis = Object.fromEntries(scored.axes.map((axis) => [axis.axis, axis.score]));
  assert.equal(byAxis.errors, 0);
  assert.equal(byAxis.copy, 3);
  assert.equal(byAxis.a11y, 2);
  assert.equal(byAxis.task, null);
  assert.equal(scored.total, Math.round((100 * 5) / 9));
  assert.equal(scored.maxSeverity, 4);
  assert.equal(scored.findings[0]?.severity, 4);
});

test("no applicable axis gives no total", () => {
  assert.equal(score({ summary: "", axes: [], findings: [] }, reviewed).total, null);
});
