import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import { isReviewed, matchesAny, type Config } from "./config.ts";
import type { Issue, PullFile, PullRequest } from "./github.ts";

// Everything about one pull request that is sent to Claude, and what had to be left out to stay within the budget.
export interface ReviewInput {
  text: string;
  reviewed: Map<string, number>; // path -> line count of the file after the change
  omitted: string[];
}

export interface Sources {
  pull: PullRequest;
  files: PullFile[];
  issues: Issue[];
  workspace: string;
  config: Config;
  taste: string | null;
  inventory: string[];
}

const MAX_TEXT_CHARS = 8_000;

// Issue numbers the pull request points at: "#12", "owner/repo#12", issue URLs of the same repository, and the
// "feat/12-..." branch naming the repositories use.
export function linkedIssues(pull: PullRequest, owner: string, repo: string): number[] {
  const numbers = new Set<number>();
  const body = pull.body ?? "";
  const ownRepo = `${owner}/${repo}`.toLowerCase();
  for (const match of body.matchAll(/(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g)) {
    if (match[1] === undefined || match[1].toLowerCase() === ownRepo) numbers.add(Number(match[2]));
  }
  for (const match of body.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/g)) {
    if (match[1]?.toLowerCase() === ownRepo) numbers.add(Number(match[2]));
  }
  const branch = /^[\w.-]+\/(\d+)-/.exec(pull.head.ref);
  if (branch) numbers.add(Number(branch[1]));
  numbers.delete(pull.number);
  return [...numbers];
}

export function numbered(content: string): string {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const width = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(width)}| ${line}`).join("\n");
}

function lineCount(content: string): number {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（${text.length - max} 文字を省略）`;
}

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

async function readText(workspace: string, file: string): Promise<string | null> {
  try {
    return await readFile(path.join(workspace, file), "utf8");
  } catch {
    return null;
  }
}

export async function buildInput(sources: Sources): Promise<ReviewInput> {
  const { pull, files, issues, workspace, config } = sources;
  let budget = config.maxInputChars;
  const parts: string[] = [];
  const omitted: string[] = [];
  const reviewed = new Map<string, number>();
  const take = (text: string): boolean => {
    if (text.length > budget) return false;
    parts.push(text);
    budget -= text.length;
    return true;
  };

  take(
    `<pull_request number="${pull.number}" title="${escapeAttr(pull.title)}" author="${escapeAttr(pull.user.login)}">\n` +
      `${clip(pull.body ?? "（本文なし）", MAX_TEXT_CHARS)}\n</pull_request>`,
  );
  for (const issue of issues) {
    take(
      `<issue number="${issue.number}" title="${escapeAttr(issue.title)}">\n${clip(issue.body ?? "（本文なし）", MAX_TEXT_CHARS)}\n</issue>`,
    );
  }

  const targets = files.filter((file) => file.status !== "removed" && isReviewed(file.filename, config));
  const listing = files
    .map((file) => {
      const mark = targets.includes(file) ? "レビュー対象" : "対象外";
      const renamed = file.previous_filename ? ` (${file.previous_filename} から)` : "";
      return `- ${file.filename}${renamed} [${file.status}, +${file.additions} -${file.deletions}, ${mark}]`;
    })
    .join("\n");
  take(`<changed_files>\n${listing}\n</changed_files>`);

  // Diffs first, so that every reviewed change is seen; whole files after, as far as the budget goes.
  const contents = new Map<string, string>();
  for (const file of targets) {
    const content = await readText(workspace, file.filename);
    if (content === null) {
      omitted.push(`${file.filename}（ファイルを読めませんでした）`);
      continue;
    }
    contents.set(file.filename, content);
    const patch = file.patch ?? "（差分が大きすぎるため GitHub が返しませんでした。下の全文を見てください）";
    if (take(`<patch path="${escapeAttr(file.filename)}">\n${patch}\n</patch>`)) {
      reviewed.set(file.filename, lineCount(content));
    } else {
      omitted.push(`${file.filename}（差分が上限を超えました）`);
    }
  }
  for (const [file, content] of contents) {
    if (!reviewed.has(file)) continue;
    if (!take(`<file path="${escapeAttr(file)}">\n${numbered(content)}\n</file>`)) {
      omitted.push(`${file} の全文（上限を超えたため差分だけを渡しました）`);
    }
  }

  for (const file of config.context) {
    if (reviewed.has(file)) continue;
    const content = await readText(workspace, file);
    if (content === null) {
      omitted.push(`${file}（参考ファイルが見つかりません）`);
    } else if (!take(`<context_file path="${escapeAttr(file)}">\n${content}\n</context_file>`)) {
      omitted.push(`${file}（参考ファイル。上限を超えました）`);
    }
  }
  if (sources.inventory.length > 0 && !take(`<inventory>\n${sources.inventory.join("\n")}\n</inventory>`)) {
    omitted.push("既存コンポーネントの一覧（上限を超えました）");
  }
  if (omitted.length > 0) {
    parts.push(`<omitted>\n入力の上限のため、次は渡していません。これらについては判断しないでください。\n${omitted.map((item) => `- ${item}`).join("\n")}\n</omitted>`);
  }
  parts.push("上の内容をレビューし、指定の JSON で答えてください。");
  return { text: parts.join("\n\n"), reviewed, omitted };
}

// Paths under the workspace that match the inventory globs, for the consistency axis.
export async function listInventory(workspace: string, globs: string[]): Promise<string[]> {
  if (globs.length === 0) return [];
  const found = new Set<string>();
  for (const pattern of globs) {
    for await (const entry of glob(pattern, { cwd: workspace })) {
      if (!matchesAny(entry, ["**/node_modules/**"])) found.add(entry.split(path.sep).join("/"));
    }
  }
  return [...found].sort();
}
