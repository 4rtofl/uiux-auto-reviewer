import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import { buildInput, linkedIssues, numbered } from "../src/context.ts";
import type { PullFile } from "../src/github.ts";
import { pull } from "./helpers.ts";

test("linked issues come from the body, same-repo URLs and the branch name", () => {
  const body = "Closes #12, see o/r#13 and other/repo#99 and https://github.com/o/r/issues/14 and #10";
  assert.deepEqual(linkedIssues(pull({ body }), "o", "r").sort((a, b) => a - b), [7, 12, 13, 14]);
});

test("numbered prefixes 1-based line numbers", () => {
  assert.equal(numbered("a\nb\n"), "1| a\n2| b");
});

async function workspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "uiux-"));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  return dir;
}

const changed = (filename: string, status: PullFile["status"] = "modified"): PullFile => ({
  filename,
  status,
  additions: 1,
  deletions: 0,
  patch: `@@ -1 +1 @@\n+${filename}`,
});

test("reviewed files get their diff and whole text; others are only listed", async () => {
  const dir = await workspace({ "src/a.tsx": "one\ntwo\nthree\n", "server/b.ts": "x\n" });
  const config = parseConfig({ paths: ["src/**"] }, "c.json");
  const input = await buildInput({
    pull: pull(),
    files: [changed("src/a.tsx"), changed("server/b.ts"), changed("src/gone.tsx", "removed")],
    issues: [],
    workspace: dir,
    config,
    taste: null,
    inventory: ["src/components/ui/button.tsx"],
  });
  assert.deepEqual([...input.reviewed], [["src/a.tsx", 3]]);
  assert.match(input.text, /<file path="src\/a.tsx">\n1\| one\n2\| two\n3\| three\n<\/file>/);
  assert.doesNotMatch(input.text, /<patch path="server\/b.ts">/);
  assert.match(input.text, /- server\/b.ts \[modified, \+1 -0, 対象外\]/);
  assert.match(input.text, /<inventory>\nsrc\/components\/ui\/button.tsx\n<\/inventory>/);
  assert.deepEqual(input.omitted, []);
});

test("over the budget, whole files go first and are reported, never silently cut", async () => {
  const dir = await workspace({ "src/a.tsx": "x".repeat(5_000) });
  const config = parseConfig({ paths: ["src/**"], maxInputChars: 1_000 }, "c.json");
  const input = await buildInput({
    pull: pull(),
    files: [changed("src/a.tsx")],
    issues: [],
    workspace: dir,
    config,
    taste: null,
    inventory: [],
  });
  assert.equal(input.reviewed.has("src/a.tsx"), true);
  assert.doesNotMatch(input.text, /<file path=/);
  assert.deepEqual(input.omitted, ["src/a.tsx の全文（上限を超えたため差分だけを渡しました）"]);
  assert.match(input.text, /<omitted>/);
});
