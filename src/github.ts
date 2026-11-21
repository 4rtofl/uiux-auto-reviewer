// The few GitHub REST calls the reviewer makes, over fetch, with the installation token of the GitHub App.
const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const GRAPHQL = process.env.GITHUB_GRAPHQL_URL ?? "https://api.github.com/graphql";

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  draft: boolean;
  html_url: string;
  user: { login: string };
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
}

export interface PullFile {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  pull_request?: unknown;
}

export interface IssueComment {
  id: number;
  body?: string;
  user: { login: string; type: string } | null;
}

export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  title: string;
  message: string;
}

export interface CheckRun {
  id: number;
  status: string;
  conclusion: string | null;
  external_id: string | null;
  app: { id: number } | null;
  output: { title: string | null; summary: string | null };
}

export interface ReviewComment {
  id: number;
  html_url: string;
  body: string;
}

export interface NewReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

export type Conclusion = "success" | "neutral" | "skipped" | "failure";

export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class GitHub {
  readonly owner: string;
  readonly repo: string;
  readonly #token: string;

  constructor(repository: string, token: string) {
    const [owner, repo] = repository.split("/");
    if (!owner || !repo) throw new Error(`owner/repo is expected, got "${repository}"`);
    this.owner = owner;
    this.repo = repo;
    this.#token = token;
  }

  async #request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const url = route.startsWith("http") ? route : `${API}/repos/${this.owner}/${this.repo}${route}`;
    const response = await fetch(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.#token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "uiux-auto-reviewer",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new GitHubError(response.status, `${method} ${route}: ${response.status} ${await response.text()}`);
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  async #graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(GRAPHQL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
        "user-agent": "uiux-auto-reviewer",
      },
      body: JSON.stringify({ query, variables }),
    });
    const result = (await response.json()) as { data?: T; errors?: { message: string }[] };
    if (!response.ok || result.errors?.length || !result.data) {
      throw new GitHubError(response.status, `GraphQL: ${response.status} ${JSON.stringify(result.errors ?? result)}`);
    }
    return result.data;
  }

  async #paginate<T>(route: string): Promise<T[]> {
    const items: T[] = [];
    const separator = route.includes("?") ? "&" : "?";
    for (let page = 1; ; page++) {
      const batch = await this.#request<T[]>("GET", `${route}${separator}per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  pull(number: number): Promise<PullRequest> {
    return this.#request("GET", `/pulls/${number}`);
  }

  pullFiles(number: number): Promise<PullFile[]> {
    return this.#paginate(`/pulls/${number}/files`);
  }

  // A file of the repository at a commit, or null when it is not there.
  async fileAt(file: string, ref: string): Promise<string | null> {
    const route = `/contents/${file.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
    try {
      const content = await this.#request<{ type: string; content?: string; encoding?: string }>("GET", route);
      if (content.type !== "file" || content.encoding !== "base64" || content.content === undefined) return null;
      return Buffer.from(content.content, "base64").toString("utf8");
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  // The files changed between two commits, or null when GitHub cannot compare them (a force push dropped the base, or
  // the comparison is over its 300-file limit).
  async changedBetween(base: string, head: string): Promise<string[] | null> {
    try {
      const comparison = await this.#request<{ files?: { filename: string; previous_filename?: string }[] }>(
        "GET",
        `/compare/${base}...${head}`,
      );
      if (!comparison.files || comparison.files.length >= 300) return null;
      return comparison.files.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]);
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 404 || error.status === 422)) return null;
      throw error;
    }
  }

  async checkRuns(sha: string, name: string): Promise<CheckRun[]> {
    const result = await this.#request<{ check_runs: CheckRun[] }>(
      "GET",
      `/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&filter=all&per_page=100`,
    );
    return result.check_runs;
  }

  checkRunAnnotations(id: number): Promise<Annotation[]> {
    return this.#paginate(`/check-runs/${id}/annotations`);
  }

  // A "Comment" review (neither approving nor requesting changes) with comments on lines of the diff.
  createReview(number: number, params: { commit_id: string; body: string; comments: NewReviewComment[] }) {
    return this.#request<{ id: number; html_url: string }>("POST", `/pulls/${number}/reviews`, { ...params, event: "COMMENT" });
  }

  reviewComments(number: number, reviewId: number): Promise<ReviewComment[]> {
    return this.#paginate(`/pulls/${number}/reviews/${reviewId}/comments`);
  }

  // The unresolved review threads whose first comment contains the marker.
  async unresolvedThreads(number: number, marker: string): Promise<string[]> {
    const ids: string[] = [];
    let after: string | null = null;
    for (;;) {
      const data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: { id: string; isResolved: boolean; comments: { nodes: { body: string }[] } }[];
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          } | null;
        };
      } = await this.#graphql(
        `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $after) {
                nodes { id isResolved comments(first: 1) { nodes { body } } }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { owner: this.owner, repo: this.repo, number, after },
      );
      const threads = data.repository.pullRequest?.reviewThreads;
      if (!threads) return ids;
      for (const thread of threads.nodes) {
        if (!thread.isResolved && thread.comments.nodes[0]?.body.includes(marker)) ids.push(thread.id);
      }
      if (!threads.pageInfo.hasNextPage) return ids;
      after = threads.pageInfo.endCursor;
    }
  }

  async resolveThread(threadId: string): Promise<void> {
    await this.#graphql(`mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`, { id: threadId });
  }

  async issue(number: number): Promise<Issue | null> {
    try {
      return await this.#request<Issue>("GET", `/issues/${number}`);
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 404 || error.status === 410)) return null;
      throw error;
    }
  }

  issueComments(number: number): Promise<IssueComment[]> {
    return this.#paginate(`/issues/${number}/comments`);
  }

  createComment(number: number, body: string): Promise<IssueComment> {
    return this.#request("POST", `/issues/${number}/comments`, { body });
  }

  updateComment(id: number, body: string): Promise<IssueComment> {
    return this.#request("PATCH", `/issues/comments/${id}`, { body });
  }

  createCheckRun(params: {
    name: string;
    head_sha: string;
    status: "in_progress";
    external_id?: string;
    details_url?: string;
    output?: { title: string; summary: string };
  }) {
    return this.#request<CheckRun>("POST", "/check-runs", params);
  }

  updateCheckRun(
    id: number,
    params: {
      status: "completed";
      conclusion: Conclusion;
      output: { title: string; summary: string; annotations?: Annotation[] };
    },
  ) {
    return this.#request<{ id: number; html_url: string }>("PATCH", `/check-runs/${id}`, params);
  }
}
