// Reviews the UI/UX of one pull request with Claude and posts the result as a check run and a pull request comment.
//
// In GitHub Actions (see action.yml) everything comes from the environment. To try it locally without posting:
//   UIUX_GITHUB_TOKEN=$(gh auth token) ANTHROPIC_API_KEY=... \
//     node src/main.ts --repo 4rtofl/Gasho --pr 123 --workspace ../Gasho --dry-run
// --print-input prints what would be sent to Claude and stops (no API key needed).
// The workspace must have the pull request's head checked out, since line numbers are read from it.
import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { isReviewed, loadConfig } from "./config.ts";
import { buildInput, linkedIssues, listInventory } from "./context.ts";
import { GitHub, type Issue } from "./github.ts";
import { annotations, headline, MARKER, renderBody, renderComment } from "./render.ts";
import { runReview } from "./review.ts";
import { score } from "./score.ts";

const CHECK_NAME = "UI/UX review";

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function eventPullNumber(): Promise<number | undefined> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return undefined;
  const event = JSON.parse(await readFile(eventPath, "utf8")) as { pull_request?: { number?: number } };
  return event.pull_request?.number;
}

function workspaceHead(workspace: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      workspace: { type: "string" },
      config: { type: "string" },
      model: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "print-input": { type: "boolean", default: false },
    },
  });
  const env = process.env;
  const dryRun = values["dry-run"] || env.UIUX_DRY_RUN === "true";
  const repository = required("--repo or GITHUB_REPOSITORY", values.repo ?? env.GITHUB_REPOSITORY);
  const number = values.pr ? Number(values.pr) : await eventPullNumber();
  if (!number) throw new Error("no pull request: pass --pr or run on a pull_request event");
  const workspace = path.resolve(values.workspace ?? env.GITHUB_WORKSPACE ?? ".");
  const configPath = values.config ?? env.UIUX_CONFIG ?? ".github/uiux-review.json";
  const model = values.model ?? env.UIUX_MODEL ?? "claude-opus-5-5";
  const github = new GitHub(repository, required("UIUX_GITHUB_TOKEN", env.UIUX_GITHUB_TOKEN ?? env.GITHUB_TOKEN));

  const pull = await github.pull(number);
  const head = workspaceHead(workspace);
  if (head !== pull.head.sha) {
    console.warn(`warning: ${workspace} is at ${head ?? "(not a git checkout)"}, the pull request head is ${pull.head.sha}`);
  }
  const config = await loadConfig(workspace, configPath);
  const files = await github.pullFiles(number);
  const targets = files.filter((file) => file.status !== "removed" && isReviewed(file.filename, config));

  const runUrl =
    env.GITHUB_RUN_ID && env.GITHUB_SERVER_URL
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined;
  const finish = async (
    conclusion: "neutral" | "skipped",
    title: string,
    summary: string,
    notes: ReturnType<typeof annotations> = [],
  ) => {
    if (dryRun) return;
    const check = await github.createCheckRun({
      name: CHECK_NAME,
      head_sha: pull.head.sha,
      status: "in_progress",
      ...(runUrl ? { details_url: runUrl } : {}),
    });
    // The API takes at most 50 annotations per call; later calls add to the earlier ones.
    for (let start = 0; start === 0 || start < notes.length; start += 50) {
      await github.updateCheckRun(check.id, {
        status: "completed",
        conclusion,
        output: { title, summary, annotations: notes.slice(start, start + 50) },
      });
    }
  };

  if (targets.length === 0) {
    console.log("No UI files changed; nothing to review.");
    await finish("skipped", "UI に関わる変更はありません", `\`${configPath}\` の対象パスに当たる変更がないため、レビューしませんでした。`);
    return;
  }

  const issues: Issue[] = [];
  for (const issueNumber of linkedIssues(pull, github.owner, github.repo)) {
    if (issues.length >= config.maxIssues) break;
    const issue = await github.issue(issueNumber);
    if (issue && !issue.pull_request) issues.push(issue);
  }
  const taste = config.taste ? await readFile(path.join(workspace, config.taste), "utf8").catch(() => null) : null;
  if (config.taste && taste === null) console.warn(`warning: taste file ${config.taste} not found`);
  const inventory = await listInventory(workspace, config.inventory);
  const input = await buildInput({ pull, files, issues, workspace, config, taste, inventory });
  console.log(
    `Reviewing ${input.reviewed.size} file(s), ${input.text.length} characters, linked issues: ${issues.map((issue) => `#${issue.number}`).join(" ") || "none"}`,
  );

  if (values["print-input"]) {
    console.log(`\n${input.text}`);
    return;
  }
  if (input.reviewed.size === 0) {
    await finish("neutral", "レビューできませんでした", `入力の上限を超えたため、どのファイルも渡せませんでした。\n\n${input.omitted.map((item) => `- ${item}`).join("\n")}`);
    return;
  }

  const apiKey = required("ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY);
  const { review, usage } = await runReview({ apiKey, model, input: input.text, taste });
  const scored = score(review, input.reviewed);
  const context = { repository, headSha: pull.head.sha, scored, summary: review.summary, omitted: input.omitted, usage };
  const comment = renderComment(context);
  console.log(`${headline(scored)}; ${scored.findings.length} finding(s), ${scored.dropped.length} dropped`);

  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${comment}\n`);
  if (dryRun) {
    console.log(`\n${comment}`);
    return;
  }
  await finish("neutral", headline(scored), renderBody(context), annotations(scored));
  const existing = (await github.issueComments(number)).find(
    (item) => item.user?.type === "Bot" && item.body?.includes(MARKER),
  );
  if (existing) await github.updateComment(existing.id, comment);
  else await github.createComment(number, comment);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
