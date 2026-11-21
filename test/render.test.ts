import assert from "node:assert/strict";
import { test } from "node:test";
import { cost, defuse, MARKER, renderComment } from "../src/render.ts";
import { reviewedSha } from "../src/reuse.ts";
import { score } from "../src/score.ts";
import { finding } from "./helpers.ts";

test("mentions and HTML comments from the model are defused", () => {
  assert.equal(defuse("ask @alice <!-- x -->"), "ask @​alice &lt;!-- x -->");
});

test("cost uses the model's prices, and unknown models have none", () => {
  const usage = { model: "claude-opus-5-5", input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000 };
  assert.equal(cost(usage), 4 + 2 + 0.2);
  assert.equal(cost({ ...usage, model: "other" }), null);
});

test("the comment links findings to the head commit and ends with the markers", () => {
  const scored = score({ summary: "総評です。", axes: [], findings: [finding({ line: 2, end_line: 4 })] }, new Map([["src/a.tsx", 10]]));
  const comment = renderComment({ repository: "o/r", headSha: "c".repeat(40), scored, summary: "総評です。", omitted: [], usage: null });
  assert.match(comment, /^## 🎨 UI\/UX レビュー/);
  assert.match(comment, new RegExp(`https://github.com/o/r/blob/${"c".repeat(40)}/src/a.tsx#L2-L4`));
  assert.match(comment, /【重大・3】削除に確認がない/);
  assert.ok(comment.includes(MARKER));
  assert.equal(reviewedSha(comment), "c".repeat(40));
  assert.match(comment, /\*\*直し方\*\*：確認ダイアログを出す/);
});

test("a finding put on its line is listed with a link instead of its full text", () => {
  const scored = score({ summary: "総評です。", axes: [], findings: [finding()] }, new Map([["src/a.tsx", 10]]));
  const context = { repository: "o/r", headSha: "c".repeat(40), scored, summary: "総評です。", omitted: [], usage: null };
  const comment = renderComment(context, new Map([[0, "https://github.com/o/r/pull/10#discussion_r1"]]));
  assert.match(comment, /→ \[行へのコメント\]\(https:\/\/github.com\/o\/r\/pull\/10#discussion_r1\)/);
  assert.doesNotMatch(comment, /直し方/);
});
