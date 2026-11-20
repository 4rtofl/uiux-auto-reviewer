import { axisLabel, SEVERITY_LABELS } from "./axes.ts";
import type { Annotation } from "./github.ts";
import type { Finding } from "./schema.ts";
import { verdict, type Scored } from "./score.ts";

export const MARKER = "<!-- uiux-auto-reviewer -->";

export interface Usage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface RenderContext {
  repository: string;
  headSha: string;
  scored: Scored;
  summary: string;
  omitted: string[];
  usage: Usage | null;
}

// US dollars per million tokens: input, output, cache write (5 minutes), cache read.
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 5, 0.2],
};

export function cost(usage: Usage): number | null {
  const price = PRICES[usage.model];
  if (!price) return null;
  const [input, output, write, read] = price;
  return (
    (usage.input_tokens * input +
      usage.output_tokens * output +
      (usage.cache_creation_input_tokens ?? 0) * write +
      (usage.cache_read_input_tokens ?? 0) * read) /
    1_000_000
  );
}

// Model text goes into a comment that notifies whoever it mentions; a zero-width space keeps "@name" from pinging.
export function defuse(text: string): string {
  return text.replaceAll(/@(?=[\w-])/g, "@​").replaceAll("<!--", "&lt;!--");
}

function oneLine(text: string): string {
  return defuse(text).replaceAll(/\s*\n\s*/g, " ").replaceAll("|", "\\|");
}

function location(context: RenderContext, finding: Finding): string {
  const lines = finding.end_line > finding.line ? `L${finding.line}-L${finding.end_line}` : `L${finding.line}`;
  const url = `https://github.com/${context.repository}/blob/${context.headSha}/${finding.file}#${lines}`;
  const label = finding.end_line > finding.line ? `${finding.file}:${finding.line}-${finding.end_line}` : `${finding.file}:${finding.line}`;
  return `[\`${label}\`](${url})`;
}

export function headline(scored: Scored): string {
  const total = scored.total === null ? "対象の観点なし" : `スコア ${scored.total} / 100`;
  return `${total}、${verdict(scored.maxSeverity)}`;
}

export function renderBody(context: RenderContext): string {
  const { scored } = context;
  const out: string[] = [];
  const applicable = scored.axes.filter((axis) => axis.score !== null).length;
  out.push(`**${verdict(scored.maxSeverity)}**`);
  out.push(
    scored.total === null
      ? "この PR の変更に関係する観点はありませんでした。"
      : `スコア **${scored.total} / 100**（関係する ${applicable} 観点の合計。各観点は指摘の最大深刻度から 0〜3 で算出）`,
  );
  out.push(defuse(context.summary));

  const rows = scored.axes.map(
    (axis) =>
      `| ${axisLabel(axis.axis)} | ${axis.score === null ? "N/A" : `${axis.score} / 3`} | ${axis.score === null ? "—" : axis.findings} |`,
  );
  out.push(["| 観点 | 点数 | 指摘 |", "|---|---|---|", ...rows].join("\n"));

  if (scored.findings.length > 0) {
    out.push("### 指摘（深刻度の高い順）");
    scored.findings.forEach((finding, index) => {
      out.push(
        [
          `#### ${index + 1}. 【${SEVERITY_LABELS[finding.severity]}・${finding.severity}】${oneLine(finding.title)}`,
          `${location(context, finding)}　観点：${axisLabel(finding.axis)}　根拠：${oneLine(finding.principle)}`,
          "",
          defuse(finding.evidence),
          "",
          `**直し方**：${defuse(finding.suggestion)}`,
        ].join("\n"),
      );
    });
  }

  const notes = scored.axes.map((axis) => `- **${axisLabel(axis.axis)}**：${oneLine(axis.note) || "（記載なし）"}`);
  out.push(`<details><summary>観点ごとに確かめたこと</summary>\n\n${notes.join("\n")}\n\n</details>`);

  if (scored.dropped.length > 0) {
    const dropped = scored.dropped.map(
      ({ finding, reason }) => `- ${oneLine(finding.title)}（\`${finding.file}:${finding.line}\`、${reason}）`,
    );
    out.push(
      `<details><summary>表示しなかった指摘（${scored.dropped.length} 件）</summary>\n\n${dropped.join("\n")}\n\n</details>`,
    );
  }
  if (context.omitted.length > 0) {
    out.push(`> [!NOTE]\n> 入力の上限のため、次はレビューしていません。\n${context.omitted.map((item) => `> - ${item}`).join("\n")}`);
  }

  const footer = [`head ${context.headSha.slice(0, 7)}`];
  if (context.usage) {
    const { usage } = context;
    const input = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    const dollars = cost(usage);
    footer.unshift(
      `${usage.model}、入力 ${input.toLocaleString("en-US")} / 出力 ${usage.output_tokens.toLocaleString("en-US")} トークン${dollars === null ? "" : `（約 $${dollars.toFixed(2)}）`}`,
    );
  }
  out.push(`<sub>${footer.join("、")}</sub>`);
  return out.join("\n\n");
}

export function renderComment(context: RenderContext): string {
  return `## 🎨 UI/UX レビュー\n\n${renderBody(context)}\n\n${MARKER}`;
}

export function annotations(scored: Scored): Annotation[] {
  return scored.findings.map((finding) => ({
    path: finding.file,
    start_line: finding.line,
    end_line: finding.end_line,
    annotation_level: finding.severity >= 4 ? "failure" : finding.severity === 3 ? "warning" : "notice",
    title: `【${SEVERITY_LABELS[finding.severity]}】${finding.title}`.slice(0, 255),
    message: `${finding.evidence}\n\n直し方：${finding.suggestion}\n（観点：${axisLabel(finding.axis)}、根拠：${finding.principle}）`.slice(0, 64_000),
  }));
}
