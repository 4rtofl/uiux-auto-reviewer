import path from "node:path";

// The per-repository settings, read from the reviewed repository (.github/uiux-review.json by default) at the pull
// request's base.
export interface Config {
  // Changed files matching these globs are reviewed; nothing else is.
  paths: string[];
  // Changed files matching these are left out even when `paths` matches them.
  exclude: string[];
  // Files sent in full as reference (design tokens, base styles), whether changed or not.
  context: string[];
  // Files listed by path only, so that the review knows which components already exist.
  inventory: string[];
  // A Markdown file of repository-specific exceptions ("animations are kept on purpose").
  taste: string | null;
  // The most characters of code, diffs and texts sent to Claude in one review.
  maxInputChars: number;
  // How many linked issues are read for the purpose of the pull request.
  maxIssues: number;
}

export const DEFAULT_CONFIG: Config = {
  paths: ["**/*.tsx", "**/*.jsx", "**/*.css", "**/*.html", "**/*.vue", "**/*.svelte"],
  exclude: ["**/node_modules/**", "**/dist/**", "**/*.test.*", "**/test/**"],
  context: [],
  inventory: [],
  taste: null,
  maxInputChars: 240_000,
  maxIssues: 3,
};

// The settings come from the tip of the pull request's base branch (not the base commit it was opened on, which may
// predate them), never its head, so that a pull request cannot loosen its own review
// (exclude its files, or add exceptions to the taste file). No file means the defaults.
export function configFromText(text: string | null, source: string): Config {
  if (text === null) return DEFAULT_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source}: not valid JSON (${(error as Error).message})`);
  }
  return parseConfig(raw, source);
}

export function parseConfig(raw: unknown, source: string): Config {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${source}: an object is expected`);
  const value = raw as Record<string, unknown>;
  const known = new Set(Object.keys(DEFAULT_CONFIG));
  for (const key of Object.keys(value)) {
    if (key !== "$schema" && !known.has(key)) throw new Error(`${source}: unknown key "${key}"`);
  }
  const strings = (key: keyof Config): string[] => {
    const field = value[key];
    if (field === undefined) return DEFAULT_CONFIG[key] as string[];
    if (!Array.isArray(field) || !field.every((item) => typeof item === "string")) {
      throw new Error(`${source}: "${key}" must be an array of strings`);
    }
    return field;
  };
  const positive = (key: "maxInputChars" | "maxIssues"): number => {
    const field = value[key];
    if (field === undefined) return DEFAULT_CONFIG[key];
    if (typeof field !== "number" || !Number.isInteger(field) || field < 0) {
      throw new Error(`${source}: "${key}" must be a non-negative integer`);
    }
    return field;
  };
  const taste = value.taste;
  if (taste !== undefined && taste !== null && typeof taste !== "string") {
    throw new Error(`${source}: "taste" must be a path or null`);
  }
  return {
    paths: strings("paths"),
    exclude: strings("exclude"),
    context: strings("context"),
    inventory: strings("inventory"),
    taste: taste ?? null,
    maxInputChars: positive("maxInputChars"),
    maxIssues: positive("maxIssues"),
  };
}

export function matchesAny(file: string, globs: string[]): boolean {
  return globs.some((glob) => path.matchesGlob(file, glob));
}

export function isReviewed(file: string, config: Config): boolean {
  return matchesAny(file, config.paths) && !matchesAny(file, config.exclude);
}
