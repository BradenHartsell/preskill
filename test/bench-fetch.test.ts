import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SkillFetchError,
  skillFilesForFolder,
  writeSkillFiles,
} from "../bench/fetch-lib.js";

test("a root-level SKILL.md gets the full tree, and a folder gets its subtree", () => {
  const blobs = ["SKILL.md", "scripts/run.py", "references/notes.md", "other/SKILL.md", "other/x.py"];
  assert.deepEqual(skillFilesForFolder(blobs, ""), blobs);
  assert.deepEqual(skillFilesForFolder(blobs, "other"), ["other/SKILL.md", "other/x.py"]);
});

test("more than 256 files is a skip, not a truncated Skill", async () => {
  const files = Array.from({ length: 257 }, (_, index) => `references/${String(index)}.txt`);
  let calls = 0;
  await assert.rejects(
    () =>
      writeSkillFiles({
        destination: "unused",
        repository: "owner/repo",
        commit: "abc",
        files,
        sourcePrefix: "",
        fetcher: (async () => {
          calls += 1;
          return new Response("");
        }) as typeof fetch,
      }),
    (error: unknown) => error instanceof SkillFetchError && error.code === "public_skill_too_many_files",
  );
  assert.equal(calls, 0);
});

test("a normal Skill writes every file it was given", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preskill-fetch-"));
  try {
    const payload = new TextEncoder().encode("hello");
    const fetcher = (async () => new Response(payload, { status: 200 })) as typeof fetch;
    await writeSkillFiles({
      destination: dir,
      repository: "o/r",
      commit: "c",
      files: ["SKILL.md", "scripts/run.py"],
      sourcePrefix: "skill",
      fetcher,
    });
    assert.equal(new TextDecoder().decode(await readFile(`${dir}/SKILL.md`)), "hello");
    assert.equal(new TextDecoder().decode(await readFile(`${dir}/scripts/run.py`)), "hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a file path that would escape the destination is refused before writing", async () => {
  await assert.rejects(
    () =>
      writeSkillFiles({
        destination: "unused",
        repository: "owner/repo",
        commit: "abc",
        files: ["../../evil"],
        sourcePrefix: "",
        fetcher: (async () => new Response("")) as typeof fetch,
      }),
    (error: unknown) => error instanceof SkillFetchError && error.code === "public_skill_unsafe_path",
  );
});

test("a Skill over the byte budget is a skip, not a partial write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preskill-fetch-"));
  try {
    const fetcher = (async () => new Response(new Uint8Array(10))) as typeof fetch;
    await assert.rejects(
      () =>
        writeSkillFiles({
          destination: dir,
          repository: "o/r",
          commit: "c",
          files: ["SKILL.md"],
          sourcePrefix: "",
          fetcher,
          maxBytes: 5,
        }),
      (error: unknown) => error instanceof SkillFetchError && error.code === "public_skill_too_large",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
