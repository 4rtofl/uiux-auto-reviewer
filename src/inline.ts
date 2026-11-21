// Findings as review comments on the lines they point at. GitHub takes a review comment only on a line that the pull
// request's diff shows (an added or a context line on the new side), and a multi-line one only within one hunk; a
// finding elsewhere stays in the summary comment alone.
import { axisLabel, SEVERITY_LABELS } from "./axes.ts";
import { defuse } from "./render.ts";
import type { Finding } from "./schema.ts";

export const FINDING_MARKER = "<!-- uiux-auto-reviewer:finding -->";
const INDEX = /<!-- uiux-auto-reviewer:finding=(\d+) -->/;

// The new-side line numbers each hunk of a unified diff shows.
export function hunks(patch: string): Set<number>[] {
  const result: Set<number>[] = [];
  let current: Set<number> | null = null;
  let line = 0;
  for (const text of patch.split("\n")) {
    const header = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      current = new Set();
      result.push(current);
      line = Number(header[1]);
      continue;
    }
    if (!current || text.startsWith("\\")) continue;
    if (text.startsWith("-")) continue;
    // "+" (added) and " " (context) lines are on the new side.
    current.add(line);
    line += 1;
  }
  return result;
}

export interface Placement {
  line: number;
  start_line?: number;
}

// Where on the diff a finding for lines first..last can be commented: the whole range when one hunk shows all of it,
// else the longest stretch of it one hunk shows, else nowhere.
export function placement(patch: string | undefined, first: number, last: number): Placement | null {
  if (!patch) return null;
  let best: { from: number; to: number } | null = null;
  for (const shown of hunks(patch)) {
    let from: number | null = null;
    for (let line = first; line <= last + 1; line++) {
      if (line <= last && shown.has(line)) {
        from ??= line;
        continue;
      }
      if (from !== null) {
        const to = line - 1;
        if (!best || to - from > best.to - best.from) best = { from, to };
        from = null;
      }
    }
  }
  if (!best) return null;
  return best.to > best.from ? { start_line: best.from, line: best.to } : { line: best.from };
}

export function findingComment(finding: Finding, index: number): string {
  return [
    `**【${SEVERITY_LABELS[finding.severity]}・${finding.severity}】${defuse(finding.title)}**`,
    "",
    defuse(finding.evidence),
    "",
    `**直し方**：${defuse(finding.suggestion)}`,
    "",
    `<sub>🎨 UI/UX レビュー　観点：${axisLabel(finding.axis)}　根拠：${defuse(finding.principle)}</sub>`,
    "",
    FINDING_MARKER,
    `<!-- uiux-auto-reviewer:finding=${index} -->`,
  ].join("\n");
}

// The index of the finding a review comment was made for, if it is one of ours.
export function findingIndex(body: string | undefined): number | null {
  const match = body?.match(INDEX);
  return match ? Number(match[1]) : null;
}
