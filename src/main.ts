// Reviews the UI/UX of one pull request with Claude and posts the result as a check run and a pull request comment.
//
// In GitHub Actions (see action.yml) everything comes from the environment. To try it locally without posting:
//   UIUX_GITHUB_TOKEN=$(gh auth token) ANTHROPIC_API_KEY=... \
//     node src/main.ts --repo 4rtofl/Gasho --pr 123 --workspace ../Gasho --dry-run
// --print-input prints what would be sent to Claude and stops (no Claude credentials needed). Without ANTHROPIC_API_KEY
// or the federation variables (see auth.ts), the SDK falls back to an `ant auth login` profile.
// The workspace must have the pull request's head checked out, since line numbers are read from it. The settings and
// the taste file are read from the pull request's base through the API.
//
// The check run is created first and always completed, even when the review fails, so that a required "UI/UX review"
// check never waits forever.
import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { clientOptions, describeAuth, resolveAuth } from "./auth.ts";
import { configFromText, isReviewed } from "./config.ts";
import { buildInput, linkedIssues, listInventory } from "./context.ts";
import { GitHub, type Annotation, type Conclusion, type Issue, type PullRequest } from "./github.ts";
import { annotations, headline, MARKER, renderBody, renderComment } from "./render.ts";
import { carriedOverNote, reviewedSha, stillHolds } from "./reuse.ts";
import { runReview } from "./review.ts";
import { score } from "./score.ts";

const CHECK_NAME = "UI/UX review";
const EXTERNAL_ID = "uiux-auto-reviewer";

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function readEvent(): Promise<{ number?: number; action?: string }> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return {};
  const event = JSON.parse(await readFile(eventPath, "utf8")) as { action?: string; pull_request?: { number?: number } };
  return { number: event.pull_request?.number, action: event.action };
}

function workspaceHead(workspace: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// The check run of this run: created in progress up front, completed exactly once. In a dry run nothing is posted.
class Check {
  #id: number | null = null;
  #appId: number | null = null;
  #done = false;
  readonly #github: GitHub;
  readonly #sha: string;
  readonly #dryRun: boolean;
  readonly #detailsUrl: string | undefined;

  constructor(github: GitHub, sha: string, dryRun: boolean, detailsUrl: string | undefined) {
    this.#github = github;
    this.#sha = sha;
    this.#dryRun = dryRun;
    this.#detailsUrl = detailsUrl;
  }

  get appId(): number | null {
    return this.#appId;
  }

  get done(): boolean {
    return this.#done;
  }

  async start(): Promise<void> {
    if (this.#dryRun) return;
    const check = await this.#github.createCheckRun({
      name: CHECK_NAME,
      head_sha: this.#sha,
      status: "in_progress",
      external_id: EXTERNAL_ID,
      output: { title: "レビューしています", summary: "Claude が UI/UX をレビューしています。数分かかります。" },
      ...(this.#detailsUrl ? { details_url: this.#detailsUrl } : {}),
    });
    this.#id = check.id;
    this.#appId = check.app?.id ?? null;
  }

  async finish(conclusion: Conclusion, title: string, summary: string, notes: Annotation[] = []): Promise<void> {
    this.#done = true;
    if (this.#id === null) return;
    // The API takes at most 50 annotations per call; later calls add to the earlier ones.
    for (let start = 0; start === 0 || start < notes.length; start += 50) {
      await this.#github.updateCheckRun(this.#id, {
        status: "completed",
        conclusion,
        output: { title: title.slice(0, 255), summary: summary.slice(0, 65_000), annotations: notes.slice(start, start + 50) },
      });
    }
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
  const printInput = values["print-input"];
  const dryRun = values["dry-run"] || printInput || env.UIUX_DRY_RUN === "true";
  const event = await readEvent();
  const repository = required("--repo or GITHUB_REPOSITORY", values.repo ?? env.GITHUB_REPOSITORY);
  const number = values.pr ? Number(values.pr) : event.number;
  if (!number) throw new Error("no pull request: pass --pr or run on a pull_request event");
  const workspace = path.resolve(values.workspace ?? env.GITHUB_WORKSPACE ?? ".");
  const configPath = values.config ?? env.UIUX_CONFIG ?? ".github/uiux-review.json";
  const model = values.model ?? env.UIUX_MODEL ?? "claude-opus-5-5";
  const github = new GitHub(repository, required("UIUX_GITHUB_TOKEN", env.UIUX_GITHUB_TOKEN ?? env.GITHUB_TOKEN));

  const pull = await github.pull(number);
  const runUrl =
    env.GITHUB_RUN_ID && env.GITHUB_SERVER_URL
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined;
  const check = new Check(github, pull.head.sha, dryRun, runUrl);
  await check.start();
  try {
    await review({ github, pull, check, event, workspace, configPath, model, dryRun, printInput });
  } catch (error) {
    if (!check.done) {
      const message = error instanceof Error ? error.message : String(error);
      await check
        .finish(
          "neutral",
          "レビューできませんでした",
          `UI/UX レビューの途中でエラーになりました。マージは止めません。\`uiux-review\` ラベルを付け直すと、もう一度試します。\n\n\`\`\`\n${message.slice(0, 2000)}\n\`\`\`${runUrl ? `\n\n[実行のログ](${runUrl})` : ""}`,
        )
        .catch((finishError: unknown) => console.error("could not complete the check run:", finishError));
    }
    throw error;
  }
}

async function review(options: {
  github: GitHub;
  pull: PullRequest;
  check: Check;
  event: { action?: string };
  workspace: string;
  configPath: string;
  model: string;
  dryRun: boolean;
  printInput: boolean;
}): Promise<void> {
  const { github, pull, check, workspace, configPath, model, dryRun } = options;
  const env = process.env;
  const head = workspaceHead(workspace);
  if (head !== pull.head.sha) {
    console.warn(`warning: ${workspace} is at ${head ?? "(not a git checkout)"}, the pull request head is ${pull.head.sha}`);
  }
  const config = configFromText(await github.fileAt(configPath, pull.base.ref), `${configPath} at ${pull.base.ref}`);
  const files = await github.pullFiles(pull.number);
  const targets = files.filter((file) => file.status !== "removed" && isReviewed(file.filename, config));

  if (targets.length === 0) {
    console.log("No UI files changed; nothing to review.");
    await check.finish("skipped", "UI に関わる変更はありません", `\`${configPath}\` の対象パスに当たる変更がないため、レビューしませんでした。`);
    return;
  }

  const comments = await github.issueComments(pull.number);
  const existing = comments.find((item) => item.user?.type === "Bot" && item.body?.includes(MARKER));

  // New commits that leave the reviewed files alone keep the last result. A label asks for a fresh review.
  if (options.event.action !== "labeled" && !options.printInput) {
    const carried = await carryOver(github, check, existing?.body, pull.head.sha, config);
    if (carried) return;
  }

  const issues: Issue[] = [];
  for (const issueNumber of linkedIssues(pull, github.owner, github.repo)) {
    if (issues.length >= config.maxIssues) break;
    const issue = await github.issue(issueNumber);
    if (issue && !issue.pull_request) issues.push(issue);
  }
  const taste = config.taste ? await github.fileAt(config.taste, pull.base.ref) : null;
  if (config.taste && taste === null) console.warn(`warning: taste file ${config.taste} not found at ${pull.base.ref}`);
  const inventory = await listInventory(workspace, config.inventory);
  const input = await buildInput({ pull, files, issues, workspace, config, taste, inventory });
  console.log(
    `Reviewing ${input.reviewed.size} file(s), ${input.text.length} characters, linked issues: ${issues.map((issue) => `#${issue.number}`).join(" ") || "none"}`,
  );

  if (options.printInput) {
    console.log(`\n${input.text}`);
    return;
  }
  if (input.reviewed.size === 0) {
    await check.finish("neutral", "レビューできませんでした", `入力の上限を超えたため、どのファイルも渡せませんでした。\n\n${input.omitted.map((item) => `- ${item}`).join("\n")}`);
    return;
  }

  const auth = resolveAuth(env);
  console.log(`Claude credentials: ${describeAuth(auth)}`);
  const { review, usage } = await runReview({ client: clientOptions(auth, env), model, input: input.text, taste });
  const scored = score(review, input.reviewed);
  const context = { repository: `${github.owner}/${github.repo}`, headSha: pull.head.sha, scored, summary: review.summary, omitted: input.omitted, usage };
  const comment = renderComment(context);
  console.log(`${headline(scored)}; ${scored.findings.length} finding(s), ${scored.dropped.length} dropped`);

  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${comment}\n`);
  if (dryRun) {
    console.log(`\n${comment}`);
    return;
  }
  await check.finish("neutral", headline(scored), renderBody(context), annotations(scored));
  if (existing) await github.updateComment(existing.id, comment);
  else await github.createComment(pull.number, comment);
}

// Copies the completed check run of the last reviewed commit to the new head, when nothing reviewed changed since.
async function carryOver(
  github: GitHub,
  check: Check,
  commentBody: string | undefined,
  headSha: string,
  config: ReturnType<typeof configFromText>,
): Promise<boolean> {
  const reviewed = reviewedSha(commentBody);
  if (!reviewed || reviewed === headSha) return false;
  if (!stillHolds(await github.changedBetween(reviewed, headSha), config)) return false;
  const previous = (await github.checkRuns(reviewed, CHECK_NAME)).find(
    (run) =>
      run.status === "completed" &&
      run.external_id === EXTERNAL_ID &&
      (check.appId === null || run.app?.id === check.appId) &&
      run.output.title !== "レビューできませんでした" &&
      (run.conclusion === "neutral" || run.conclusion === "success" || run.conclusion === "failure"),
  );
  if (!previous?.conclusion || !previous.output.title) return false;
  const notes = (await github.checkRunAnnotations(previous.id)).map(
    ({ path: file, start_line, end_line, annotation_level, title, message }): Annotation => ({
      path: file,
      start_line,
      end_line,
      annotation_level,
      title,
      message,
    }),
  );
  console.log(`Nothing reviewed changed since ${reviewed}; carrying its result over.`);
  await check.finish(
    previous.conclusion as Conclusion,
    previous.output.title,
    `${carriedOverNote(reviewed)}\n\n${previous.output.summary ?? ""}`,
    notes,
  );
  return true;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
