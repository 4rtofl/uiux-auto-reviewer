import type { PullRequest } from "../src/github.ts";
import type { Finding } from "../src/schema.ts";

export function pull(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 10,
    title: "Add a delete button",
    body: null,
    draft: false,
    html_url: "https://github.com/o/r/pull/10",
    user: { login: "someone" },
    head: { sha: "a".repeat(40), ref: "feat/7-delete" },
    base: { sha: "b".repeat(40), ref: "main" },
    ...overrides,
  };
}

export function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    axis: "errors",
    title: "削除に確認がない",
    file: "src/a.tsx",
    line: 3,
    end_line: 3,
    evidence: "onClick で削除 API を直接呼んでいる",
    principle: "Nielsen #5",
    frequency: "common",
    impact: "hard_to_overcome",
    persistence: "repeated",
    severity: 3,
    confidence: "high",
    suggestion: "確認ダイアログを出す",
    ...overrides,
  };
}
