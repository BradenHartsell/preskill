import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { skillFilesForCheck } from "../src/file-review.js";
import { readSkillFolder, readSkillTarget, readSkillZip, SkillInputError } from "../src/node.js";
import { makeTar, makeZip, skillMd } from "./helpers.js";

test("a zip keeps .git and node_modules files, which are judged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preskill-hidden-"));
  try {
    const zip = makeZip([
      { path: "SKILL.md", data: new TextEncoder().encode(skillMd("hidden-skill", "A skill")) },
      { path: ".git/hooks/pre-commit", data: new TextEncoder().encode("#!/bin/sh\necho hook\n") },
      { path: "node_modules/.bin/foo", data: new TextEncoder().encode("#!/bin/sh\necho foo\n") },
      { path: "__MACOSX/._notes", data: new TextEncoder().encode("metadata") },
    ]);
    const target = join(dir, "skill.zip");
    await writeFile(target, zip);
    const files = await readSkillZip(target);
    assert.deepEqual(
      files.map((file) => file.path).sort(),
      ["SKILL.md", ".git/hooks/pre-commit", "node_modules/.bin/foo", "__MACOSX/._notes"].sort(),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a local folder keeps .git and node_modules files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preskill-hidden-"));
  try {
    await mkdir(join(dir, ".git", "hooks"), { recursive: true });
    await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(dir, "SKILL.md"), skillMd("hidden-skill", "A skill"));
    await writeFile(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho hook\n");
    await writeFile(join(dir, "node_modules", ".bin", "foo"), "#!/bin/sh\necho foo\n");
    const files = await readSkillFolder(dir);
    assert.ok(files.some((file) => file.path === ".git/hooks/pre-commit"));
    assert.ok(files.some((file) => file.path === "node_modules/.bin/foo"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a ZIP symlink entry is refused with a plain reason", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preskill-symlink-"));
  try {
    const zip = makeZip([
      { path: "SKILL.md", data: new TextEncoder().encode(skillMd("link-skill", "A skill")) },
      { path: "assets/link", data: new TextEncoder().encode("../outside"), symlink: true },
    ]);
    const target = join(dir, "skill.zip");
    await writeFile(target, zip);
    await assert.rejects(
      () => readSkillZip(target),
      (error: unknown) =>
        error instanceof SkillInputError &&
        error.code === "skill_symlink" &&
        /symbolic link/u.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a symlink named .DS_Store is refused, not silently dropped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preskill-ds-store-"));
  try {
    const zip = makeZip([
      { path: "SKILL.md", data: new TextEncoder().encode(skillMd("link-skill", "A skill")) },
      { path: ".DS_Store", data: new TextEncoder().encode("../outside"), symlink: true },
    ]);
    const target = join(dir, "skill.zip");
    await writeFile(target, zip);
    await assert.rejects(
      () => readSkillZip(target),
      (error: unknown) => error instanceof SkillInputError && error.code === "skill_symlink",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a top-level zip path that climbs out is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preskill-zip-path-"));
  try {
    const zip = makeZip([
      { path: "SKILL.md", data: new TextEncoder().encode(skillMd("path-skill", "A skill")) },
      { path: "../evil.txt", data: new TextEncoder().encode("x") },
    ]);
    const target = join(dir, "skill.zip");
    await writeFile(target, zip);
    await assert.rejects(
      () => readSkillZip(target),
      (error: unknown) =>
        error instanceof SkillInputError &&
        error.code === "skill_source_path_invalid" &&
        /climbs out of the Skill/u.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a zip over the compressed byte budget is refused before unpacking", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preskill-zip-size-"));
  try {
    const target = join(dir, "large.zip");
    await writeFile(target, Buffer.alloc(16 * 1024 * 1024 + 1));
    await assert.rejects(
      () => readSkillZip(target),
      (error: unknown) =>
        error instanceof SkillInputError &&
        error.code === "skill_source_too_large" &&
        /larger than 16 MiB/u.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a damaged zip has a damaged code, not a size code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preskill-damaged-"));
  try {
    const target = join(dir, "skill.zip");
    await writeFile(target, Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
    await assert.rejects(
      () => readSkillZip(target),
      (error: unknown) =>
        error instanceof SkillInputError &&
        error.code === "skill_source_damaged_or_password_protected" &&
        /damaged or password-protected/u.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a symlink inside a Skill's archive is a file refusal", async () => {
  const zip = makeZip([
    { path: "assets/link", data: new TextEncoder().encode("../outside"), symlink: true },
  ]);
  const result = await skillFilesForCheck(
    { name: "link-skill", description: "A skill", bodyMarkdown: "Use assets/link" },
    [{ path: "bundle.zip", bytes: zip }],
  );
  assert.equal(result.files.length, 0);
  assert.equal(result.refusals[0]?.code, "symlink");
});

test("a tar symlink is a file refusal", async () => {
  const tar = makeTar([{ path: "assets/link", data: new Uint8Array(), symlink: true }]);
  const result = await skillFilesForCheck(
    { name: "link-skill", description: "A skill", bodyMarkdown: "Use assets/link" },
    [{ path: "bundle.tar", bytes: tar }],
  );
  assert.equal(result.files.length, 0);
  assert.equal(result.refusals[0]?.code, "symlink");
});

test("a symlink at the top-level input path is refused", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "preskill-root-symlink-"));
  try {
    const real = join(dir, "real");
    await mkdir(real);
    await writeFile(join(real, "SKILL.md"), skillMd("link-skill", "A skill"));
    const link = join(dir, "skill-link");
    try {
      await symlink(real, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error instanceof Error && /EPERM|EACCES|UNKNOWN/u.test(error.message)) {
        t.skip("symlink creation is not permitted on this host");
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => readSkillTarget(link),
      (error: unknown) => error instanceof SkillInputError && error.code === "skill_symlink",
    );
    await assert.rejects(
      () => readSkillFolder(link),
      (error: unknown) => error instanceof SkillInputError && error.code === "skill_symlink",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a symlink in a local folder is refused", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "preskill-local-symlink-"));
  try {
    await writeFile(join(dir, "SKILL.md"), skillMd("link-skill", "A skill"));
    await writeFile(join(dir, "target.txt"), "target");
    try {
      await symlink(join(dir, "target.txt"), join(dir, "link.txt"), "file");
    } catch (error) {
      if (error instanceof Error && /EPERM|EACCES/u.test(error.message)) {
        t.skip("symlink creation is not permitted on this host");
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => readSkillFolder(dir),
      (error: unknown) =>
        error instanceof SkillInputError &&
        error.code === "skill_symlink" &&
        /symbolic link/u.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
