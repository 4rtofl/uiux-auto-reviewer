// When a pull request gets new commits that touch none of the reviewed files, the last review still holds; its result is
// carried over to the new head instead of paying for the same review again.
import { isReviewed, type Config } from "./config.ts";

const REVIEWED = /<!-- uiux-auto-reviewer:reviewed=([0-9a-f]{40}) -->/;

export function reviewedMarker(sha: string): string {
  return `<!-- uiux-auto-reviewer:reviewed=${sha} -->`;
}

// The head the comment's review was made on, if the comment says so.
export function reviewedSha(body: string | undefined): string | null {
  return body?.match(REVIEWED)?.[1] ?? null;
}

// True when none of the files changed since the reviewed commit is one the review looks at. Null (GitHub could not
// compare the two commits) is never reusable.
export function stillHolds(changed: string[] | null, config: Config): boolean {
  return changed !== null && !changed.some((file) => isReviewed(file, config));
}

export function carriedOverNote(reviewed: string): string {
  return `> [!NOTE]\n> \`${reviewed.slice(0, 7)}\` のレビュー結果を引き継いでいます。そのあとの変更に、レビューの対象のファイルがないためです。もう一度レビューするには \`uiux-review\` ラベルを付け直してください。`;
}
