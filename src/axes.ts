// The review axes, in the order they are shown. Each is scored 0-3 from the findings filed under it, or N/A.
export const AXES = [
  { id: "task", label: "やりたいことの達成" },
  { id: "states", label: "状態の網羅" },
  { id: "feedback", label: "反応の速さ" },
  { id: "errors", label: "失敗の予防と回復" },
  { id: "consistency", label: "既存画面との一貫性" },
  { id: "a11y", label: "アクセシビリティ" },
  { id: "mobile", label: "モバイル" },
  { id: "copy", label: "文言" },
  { id: "visual", label: "見た目" },
] as const;

export type AxisId = (typeof AXES)[number]["id"];
export const AXIS_IDS = AXES.map((axis) => axis.id) as [AxisId, ...AxisId[]];

export function axisLabel(id: AxisId): string {
  return AXES.find((axis) => axis.id === id)?.label ?? id;
}

// Nielsen's severity ratings, 0-4.
export const SEVERITY_LABELS = ["問題なし", "見た目のみ", "軽微", "重大", "致命的"] as const;
