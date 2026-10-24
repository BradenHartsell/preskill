import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const coreFiles = [
  "archive.ts",
  "credentials.ts",
  "fetch.ts",
  "file-review.ts",
  "index.ts",
  "judge.ts",
  "mime.ts",
  "questions.ts",
  "scanner.ts",
  "skill.ts",
  "split.ts",
  "text.ts",
  "types.ts",
  "version.ts",
];

test("no core file imports a Node built-in", async () => {
  for (const file of coreFiles) {
    const source = await readFile(join(process.cwd(), "src", file), "utf8");
    assert.doesNotMatch(source, /(?:from|import\()\s*["']node:/u, file);
  }
});

test("the core entry does not re-export the Node or CLI entry points", async () => {
  const index = await readFile(join(process.cwd(), "src", "index.ts"), "utf8");
  assert.doesNotMatch(index, /from\s+["']\.\/(?:node|cli)\.js["']/u);
});
