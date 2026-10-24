/**
 * Node-only input helpers: a local folder, a zip of a Skill, or a path to its
 * SKILL.md. The core scanner never imports this module.
 */

import { readdir, readFile, lstat, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { ArchiveError, unzip, type ArchiveBudget, type ArchiveEntry } from "./archive.js";
import { bundleMaxBytes, bundleMaxFiles, isSafeSkillPath } from "./fetch.js";
import type { SkillInputFile } from "./types.js";

const ignoredNames = new Set([".DS_Store", "Thumbs.db"]);

/** A local input problem, with a plain message the CLI can show. */
export class SkillInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SkillInputError";
  }
}

function junk(path: string): boolean {
  const segments = path.split("/");
  return ignoredNames.has(segments.at(-1) ?? "");
}

async function walk(
  root: string,
  current: string,
  output: SkillInputFile[],
  budget: { bytes: number },
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(current, entry.name);
    const relativePath = relative(root, full).split(sep).join("/");
    if (entry.isSymbolicLink()) {
      throw new SkillInputError("skill_symlink", `${relativePath} is a symbolic link, which cannot be judged.`);
    }
    if (junk(relativePath)) continue;
    if (entry.isDirectory()) {
      await walk(root, full, output, budget);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isSafeSkillPath(relativePath)) {
      throw new SkillInputError("skill_source_path_invalid", `${relativePath} is not a safe relative path.`);
    }
    if (output.length >= bundleMaxFiles) {
      throw new SkillInputError("skill_source_too_large", "The Skill has more than 256 files, so it cannot be judged.");
    }
    const bytes = new Uint8Array(await readFile(full));
    budget.bytes += bytes.byteLength;
    if (budget.bytes > bundleMaxBytes) {
      throw new SkillInputError("skill_source_too_large", "The Skill is larger than 16 MiB, so it cannot be judged.");
    }
    output.push({ path: relativePath, bytes });
  }
}

/** Read every regular file under a local Skill folder. */
export async function readSkillFolder(folder: string): Promise<SkillInputFile[]> {
  const root = resolve(folder);
  if ((await lstat(root)).isSymbolicLink()) {
    throw new SkillInputError("skill_symlink", `${folder} is a symbolic link, which cannot be judged.`);
  }
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error("skill_source_not_a_folder");
  const output: SkillInputFile[] = [];
  await walk(root, root, output, { bytes: 0 });
  output.sort((left, right) => left.path.localeCompare(right.path));
  return output;
}

function cleanEntries(entries: readonly ArchiveEntry[]): ArchiveEntry[] {
  const unsafe = entries.find((entry) => !isSafeSkillPath(entry.path));
  if (unsafe) {
    throw new SkillInputError("skill_source_path_invalid", `${unsafe.path} is not a safe relative path.`);
  }
  return entries.filter((entry) => entry.symlink === true || !junk(entry.path));
}

function stripCommonFolder(entries: readonly ArchiveEntry[]): SkillInputFile[] {
  const clean = cleanEntries(entries);
  const symlink = clean.find((entry) => entry.symlink);
  if (symlink) {
    throw new SkillInputError("skill_symlink", `${symlink.path} is a symbolic link, which cannot be judged.`);
  }
  if (clean.some((entry) => entry.path === "SKILL.md")) {
    return clean.map((entry) => ({ path: entry.path, bytes: entry.bytes }));
  }
  const roots = new Set(clean.map((entry) => entry.path.split("/")[0] ?? ""));
  if (roots.size === 1) {
    const stripped = clean
      .map((entry) => ({ ...entry, path: entry.path.split("/").slice(1).join("/") }))
      .filter((entry) => entry.path.length > 0 && isSafeSkillPath(entry.path));
    if (stripped.some((entry) => entry.path === "SKILL.md")) {
      return stripped.map((entry) => ({ path: entry.path, bytes: entry.bytes }));
    }
  }
  return clean.map((entry) => ({ path: entry.path, bytes: entry.bytes }));
}

/** Read a zip of one Skill folder. A single enclosing folder is stripped. */
export async function readSkillZip(file: string): Promise<SkillInputFile[]> {
  if ((await lstat(file)).isSymbolicLink()) {
    throw new SkillInputError("skill_symlink", `${file} is a symbolic link, which cannot be judged.`);
  }
  const info = await stat(file);
  if (info.size > bundleMaxBytes) {
    throw new SkillInputError(
      "skill_source_too_large",
      `The zip is larger than ${bundleMaxBytes / (1024 * 1024)} MiB, so it cannot be judged.`,
    );
  }
  const bytes = new Uint8Array(await readFile(file));
  const budget: ArchiveBudget = { bytes: 0, entries: 0 };
  let entries: ArchiveEntry[];
  try {
    entries = unzip(bytes, budget);
  } catch (error) {
    if (error instanceof ArchiveError) {
      const code =
        error.reason === "archive too large or too deep"
          ? "skill_source_too_large"
          : error.reason === "unsafe path"
            ? "skill_source_path_invalid"
            : "skill_source_damaged_or_password_protected";
      const message =
        error.reason === "archive too large or too deep"
          ? "The zip unpacks to more files or data than one Skill can hold."
          : error.reason === "unsafe path"
            ? "The zip contains a path that climbs out of the Skill."
            : "The zip is damaged or password-protected.";
      throw new SkillInputError(code, message);
    }
    throw error;
  }
  const files = stripCommonFolder(entries);
  if (!files.some((entry) => entry.path === "SKILL.md")) {
    throw new SkillInputError("skill_manifest_missing", "The zip has no SKILL.md at the top of the Skill.");
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** Read a local folder, a zip, or a path to a SKILL.md in its folder. */
export async function readSkillTarget(target: string): Promise<SkillInputFile[]> {
  const resolved = resolve(target);
  if ((await lstat(resolved)).isSymbolicLink()) {
    throw new SkillInputError("skill_symlink", `${target} is a symbolic link, which cannot be judged.`);
  }
  const info = await stat(resolved);
  if (info.isDirectory()) return readSkillFolder(resolved);
  if (target.toLowerCase().endsWith(".zip")) return readSkillZip(target);
  if (basename(target).toLowerCase() === "skill.md") return readSkillFolder(resolve(target, ".."));
  throw new Error("skill_source_not_supported");
}
