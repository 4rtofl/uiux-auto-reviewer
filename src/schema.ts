import { z } from "zod";
import { AXIS_IDS } from "./axes.ts";

// What Claude returns. The JSON Schema below is sent as the structured output format, and the same shape is checked
// again with zod after parsing, so that nothing downstream trusts the raw text.
export const FindingSchema = z.object({
  axis: z.enum(AXIS_IDS),
  title: z.string(),
  file: z.string(),
  line: z.number().int(),
  end_line: z.number().int(),
  evidence: z.string(),
  principle: z.string(),
  frequency: z.enum(["rare", "common"]),
  impact: z.enum(["easy_to_overcome", "hard_to_overcome"]),
  persistence: z.enum(["once", "repeated"]),
  severity: z.number().int().min(0).max(4),
  confidence: z.enum(["high", "medium", "low"]),
  suggestion: z.string(),
});

export const AxisNoteSchema = z.object({
  axis: z.enum(AXIS_IDS),
  applicable: z.boolean(),
  note: z.string(),
});

export const ReviewSchema = z.object({
  summary: z.string(),
  axes: z.array(AxisNoteSchema),
  findings: z.array(FindingSchema),
});

export type Finding = z.infer<typeof FindingSchema>;
export type AxisNote = z.infer<typeof AxisNoteSchema>;
export type Review = z.infer<typeof ReviewSchema>;

const str = (description: string) => ({ type: "string", description });

export const REVIEW_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "axes", "findings"],
  properties: {
    summary: str("PR 全体の総評。2〜3 文、です・ます調"),
    axes: {
      type: "array",
      description: "9 つの観点すべてについて 1 件ずつ",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["axis", "applicable", "note"],
        properties: {
          axis: { type: "string", enum: AXIS_IDS },
          applicable: { type: "boolean", description: "この PR の変更がこの観点に関係するか" },
          note: str("何を確かめたか、または関係しない理由。1 文"),
        },
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "axis",
          "title",
          "file",
          "line",
          "end_line",
          "evidence",
          "principle",
          "frequency",
          "impact",
          "persistence",
          "severity",
          "confidence",
          "suggestion",
        ],
        properties: {
          axis: { type: "string", enum: AXIS_IDS },
          title: str("指摘の要点。1 文"),
          file: str("リポジトリのルートからのパス。レビュー対象として渡されたファイルに限る"),
          line: { type: "integer", description: "変更後のファイルでの開始行（1 始まり）" },
          end_line: { type: "integer", description: "終了行。1 行だけなら line と同じ" },
          evidence: str("コードのどこから何がわかるか。推測ではなく、コードに書かれている事実"),
          principle: str("根拠にした原則。例：Nielsen #1、WCAG 2.5.8、UI Stack の Empty、unslop U4"),
          frequency: { type: "string", enum: ["rare", "common"] },
          impact: { type: "string", enum: ["easy_to_overcome", "hard_to_overcome"] },
          persistence: { type: "string", enum: ["once", "repeated"] },
          severity: { type: "integer", enum: [0, 1, 2, 3, 4] },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          suggestion: str("直し方。具体的に 1〜2 文"),
        },
      },
    },
  },
} as const;
