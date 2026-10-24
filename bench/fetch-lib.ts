/** Pure-ish helpers for the public benchmark fetcher, kept testable. */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isSafeSkillPath } from "../src/fetch.js";

export const maxSkillFiles = 256;
export const maxSkillBytes = 16 * 1024 * 1024;

export type SkillFetchErrorCode =
  | "public_skill_too_many_files"
  | "public_skill_too_large"
  | "public_skill_unsafe_path";

export class SkillFetchError extends Error {
  constructor(readonly code: SkillFetchErrorCode) {
    super(code);
    this.name = "SkillFetchError";
  }
}

/** Every blob under a Skill folder. A root-level SKILL.md gets the whole tree. */
export function skillFilesForFolder(blobs: readonly string[], folder: string): string[] {
  const prefix = folder ? `${folder}/` : "";
  return blobs.filter((path) => (folder ? path.startsWith(prefix) : true));
}

export interface WriteSkillFilesOptions {
  readonly destination: string;
  readonly repository: string;
  readonly commit: string;
  readonly files: readonly string[];
  readonly sourcePrefix: string;
  readonly fetcher?: typeof fetch;
  readonly maxBytes?: number;
}

/**
 * Download one Skill's files. A Skill over 256 files or 16 MiB is a skip, not
 * a partial Skill: the caller counts it as skipped and never judges a cut-down
 * copy.
 */
export async function writeSkillFiles(options: WriteSkillFilesOptions): Promise<number> {
  if (options.files.length > maxSkillFiles) throw new SkillFetchError("public_skill_too_many_files");
  const fetcher = options.fetcher ?? fetch.bind(globalThis);
  const maxBytes = options.maxBytes ?? maxSkillBytes;
  await mkdir(options.destination, { recursive: true });
  let total = 0;
  try {
    for (const file of options.files) {
      const relative =
        options.sourcePrefix && file.startsWith(`${options.sourcePrefix}/`)
          ? file.slice(options.sourcePrefix.length + 1)
          : file;
      if (!isSafeSkillPath(relative)) throw new SkillFetchError("public_skill_unsafe_path");
      const url = `https://raw.githubusercontent.com/${options.repository}/${options.commit}/${file
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
      const response = await fetcher(url);
      if (!response.ok) throw new Error(`public_file_failed:${response.status}:${options.repository}:${file}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      total += bytes.byteLength;
      if (total > maxBytes) throw new SkillFetchError("public_skill_too_large");
      const target = join(options.destination, ...relative.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
  } catch (error) {
    await rm(options.destination, { recursive: true, force: true });
    throw error;
  }
  return total;
}

export function isSkippableSkillFetch(error: unknown): error is SkillFetchError {
  return error instanceof SkillFetchError;
}
