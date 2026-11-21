// The few GitHub REST calls the reviewer makes, over fetch, with the installation token of the GitHub App.
const API = process.env.GITHUB_API_URL ?? "https://api.github.com";

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

  createCheckRun(params: { name: string; head_sha: string; status: "in_progress"; details_url?: string }) {
    return this.#request<{ id: number; html_url: string }>("POST", "/check-runs", params);
  }

  updateCheckRun(
    id: number,
    params: {
      status: "completed";
      conclusion: "success" | "neutral" | "skipped" | "failure";
      output: { title: string; summary: string; annotations?: Annotation[] };
    },
  ) {
    return this.#request<{ id: number; html_url: string }>("PATCH", `/check-runs/${id}`, params);
  }
}
