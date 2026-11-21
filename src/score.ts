import { AXES, type AxisId } from "./axes.ts";
import type { AxisNote, Finding, Review } from "./schema.ts";

export interface Dropped {
  finding: Finding;
  reason: string;
}

export interface AxisScore {
  axis: AxisId;
  score: number | null; // null = N/A
  findings: number;
  note: string;
}

export interface Scored {
  findings: Finding[]; // kept, most severe first
  dropped: Dropped[];
  axes: AxisScore[];
  total: number | null; // 0-100 over the applicable axes
  maxSeverity: number; // 0 when nothing is left
}

// Keeps only the findings that point at a real place in a reviewed file and that the model is not unsure of. A finding
// that cannot be traced to code is how a reviewer's guess turns into noise, so it is dropped rather than shown.
export function filterFindings(findings: Finding[], reviewed: Map<string, number>): { kept: Finding[]; dropped: Dropped[] } {
  const kept: Finding[] = [];
  const dropped: Dropped[] = [];
  for (const finding of findings) {
    const lines = reviewed.get(finding.file);
    const reason =
      finding.severity === 0
        ? "深刻度 0（問題ではない）"
        : finding.confidence === "low"
          ? "確信度が低い"
          : lines === undefined
            ? "レビュー対象外のファイル"
            : finding.line < 1 || finding.line > lines
              ? "行番号がファイルの範囲外"
              : finding.evidence.trim() === ""
                ? "根拠がない"
                : null;
    if (reason === null) {
      kept.push({ ...finding, end_line: Math.min(Math.max(finding.end_line, finding.line), lines!) });
    } else {
      dropped.push({ finding, reason });
    }
  }
  kept.sort((a, b) => b.severity - a.severity || a.file.localeCompare(b.file) || a.line - b.line);
  return { kept, dropped };
}

// An axis scores 3 with no findings, 2 when its worst finding is minor (severity 1-2), 1 for a major one (3) and 0 for
// a catastrophe (4). Deriving the score from the findings keeps it reproducible: the model never picks a number.
export function axisScore(maxSeverity: number): number {
  if (maxSeverity >= 4) return 0;
  if (maxSeverity === 3) return 1;
  if (maxSeverity >= 1) return 2;
  return 3;
}

export function score(review: Review, reviewed: Map<string, number>): Scored {
  const { kept, dropped } = filterFindings(review.findings, reviewed);
  const notes = new Map<AxisId, AxisNote>(review.axes.map((note) => [note.axis, note]));
  const axes = AXES.map(({ id }): AxisScore => {
    const own = kept.filter((finding) => finding.axis === id);
    const note = notes.get(id);
    const applicable = own.length > 0 || note?.applicable === true;
    const worst = Math.max(0, ...own.map((finding) => finding.severity));
    return { axis: id, score: applicable ? axisScore(worst) : null, findings: own.length, note: note?.note ?? "" };
  });
  const applicable = axes.filter((axis) => axis.score !== null);
  const total =
    applicable.length === 0
      ? null
      : Math.round((100 * applicable.reduce((sum, axis) => sum + (axis.score ?? 0), 0)) / (3 * applicable.length));
  return { findings: kept, dropped, axes, total, maxSeverity: Math.max(0, ...kept.map((finding) => finding.severity)) };
}

export function verdict(maxSeverity: number): string {
  if (maxSeverity >= 4) return "致命的な問題があります（リリース前に修正）";
  if (maxSeverity === 3) return "大きな問題があります（優先して修正）";
  if (maxSeverity >= 1) return "小さな指摘のみです";
  return "指摘はありません";
}
