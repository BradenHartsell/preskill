/**
 * Raw-file fetching for a Skill link. No GitHub token and no GitHub API: the
 * SKILL.md is read by its raw address, then every file its text names, and
 * every file those name, from the same folder. A file named but not readable
 * is reported, never silently dropped; the scanner turns that into a refusal.
 * Files the Skill never names are not read, because a raw host cannot list a
 * folder.
 */

import type { Ruleset, SkillInputFile, SkillMissingFile, SkillSource } from "./types.js";

export const bundleMaxBytes = 16 * 1024 * 1024;
export const bundleMaxFiles = 256;
const pathMaxLength = 512;

export interface FetchedSkill {
  readonly files: readonly SkillInputFile[];
  readonly source: SkillSource;
  readonly missingFiles: readonly SkillMissingFile[];
}

export interface FetchSkillOptions {
  readonly fetch?: typeof fetch;
  /**
   * Default `"v1"`. Under `"v2"` the reader also follows bare document names in
   * prose (`see REFERENCE.md`, outside fenced code), and marks one the host does
   * not find with `bareName`, which `scanSkill` under v2 flags instead of refusing.
   */
  readonly ruleset?: Ruleset;
}

/** A pasted link as an https URL without its fragment. */
export function skillLinkUrl(reference: string): URL {
  let url: URL;
  try {
    url = new URL(reference.trim());
  } catch {
    throw new Error("skill_source_invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("skill_source_not_supported");
  url.hash = "";
  return url;
}

interface ManifestAddress {
  url: URL;
  folder: URL;
  sourceType: "github" | "direct";
}

const githubNamePattern = /^[A-Za-z0-9._-]+$/u;

/**
 * Where a link's SKILL.md is, read without the GitHub API:
 * `github.com/o/r` (the default branch, `HEAD`), `github.com/o/r/tree/<ref>/<folder>`,
 * `github.com/o/r/blob/<ref>/<folder>/SKILL.md`, a raw.githubusercontent.com
 * SKILL.md, or any https address ending in `/SKILL.md`.
 */
export function skillManifestAddress(url: URL): ManifestAddress {
  const host = url.hostname.toLowerCase();
  if (host === "github.com" || host === "www.github.com") {
    let segments: string[];
    try {
      segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    } catch {
      throw new Error("skill_source_invalid");
    }
    const [owner = "", rawRepo = "", kind, ...rest] = segments;
    const repo = rawRepo.replace(/\.git$/u, "");
    if (!githubNamePattern.test(owner) || !githubNamePattern.test(repo)) throw new Error("skill_source_invalid");
    let refAndFolder: string[];
    if (kind === undefined) refAndFolder = ["HEAD"];
    else if (kind === "tree" && rest.length > 0) refAndFolder = rest;
    else if (kind === "blob" && rest.length > 1 && isManifestName(rest.at(-1))) refAndFolder = rest.slice(0, -1);
    else throw new Error("skill_source_not_supported");
    const folder = new URL(
      `https://raw.githubusercontent.com/${[owner, repo, ...refAndFolder]
        .map(encodeURIComponent)
        .join("/")}/`,
    );
    return { url: new URL("SKILL.md", folder), folder, sourceType: "github" };
  }
  if (!isManifestName(url.pathname.split("/").at(-1))) throw new Error("skill_source_not_supported");
  url.search = "";
  return { url, folder: new URL(".", url), sourceType: host === "raw.githubusercontent.com" ? "github" : "direct" };
}

function isManifestName(segment: string | undefined): boolean {
  return segment?.toLowerCase() === "skill.md";
}

function parentFolder(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash + 1);
}

/** File extensions a Skill's text can name as one of its own files. */
const skillFileExtensions = new Set([
  "md", "markdown", "txt", "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "sh", "bash", "ps1", "bat", "rb", "go", "rs",
  "java", "kt", "swift", "php", "pl", "lua", "r", "sql", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "csv", "tsv",
  "xml", "html", "htm", "css", "svg", "png", "jpg", "jpeg", "gif", "webp", "pdf", "docx", "xlsx", "pptx", "ttf", "otf",
  "woff", "woff2", "ipynb", "j2", "jinja", "tmpl", "template", "c", "h", "cpp", "hpp", "cs", "zip", "tar", "gz", "tgz",
  "jar", "whl", "pyc", "class", "wasm",
]);

const markdownLinkTarget = /\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/gu;
const referenceLinkTarget = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gmu;
const pathMention = /(?<![\w./@:-])((?:\.\/)?[A-Za-z0-9_][\w.-]*(?:\/[\w.-]+)+)(?![\w/-])/gu;

/**
 * Ruleset v2: a bare document name in prose, the usual way a Skill names a
 * reference file ("see REFERENCE.md", "read FORMS.md"). Only document
 * extensions: Skills name example files (`input.pdf`, `package.json`) that
 * are not their own, and a fenced code block is example code, so fenced
 * blocks are skipped.
 */
const bareDocumentMention = /(?<![\w./@:\\-])([A-Za-z0-9_][\w.-]*\.(?:md|markdown|txt))(?!\.?[\w/-])/giu;
const fencedCodeBlock = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gmu;

/** One file a text names, and whether it was named only as a bare document name. */
export interface NamedSkillFile {
  readonly path: string;
  readonly bareName: boolean;
}

/**
 * The Skill's own files a text names, as paths from the Skill's root: the
 * targets of Markdown links, and any relative path with a folder and a file
 * extension (`scripts/fill_form.py`, `references/api.md`). Addresses with a
 * scheme, absolute paths, and anything climbing out of the Skill are not its
 * files. Under ruleset v2, bare document names in prose outside fenced code
 * (`REFERENCE.md`) are also named, read like a link from the naming file's folder.
 */
export function namedSkillFiles(text: string, fromFolder: string, options: { readonly ruleset?: Ruleset } = {}): string[] {
  return namedSkillFileRefs(text, fromFolder, options).map((file) => file.path);
}

/** `namedSkillFiles`, with whether each path was named only as a bare document name. */
export function namedSkillFileRefs(
  text: string,
  fromFolder: string,
  options: { readonly ruleset?: Ruleset } = {},
): NamedSkillFile[] {
  const named: NamedSkillFile[] = [];
  const add = (raw: string | undefined, linked: boolean, bareName: boolean): void => {
    const path = skillRelativePath(raw ?? "", fromFolder, linked);
    if (path && !named.some((file) => file.path === path)) named.push({ path, bareName });
  };
  for (const match of text.matchAll(markdownLinkTarget)) add(match[1], true, false);
  for (const match of text.matchAll(referenceLinkTarget)) add(match[1], true, false);
  for (const match of text.matchAll(pathMention)) add(match[1], false, false);
  if (options.ruleset === "v2") {
    for (const match of text.replace(fencedCodeBlock, "").matchAll(bareDocumentMention)) {
      if (!isManifestName(match[1])) add(match[1], true, true);
    }
  }
  return named;
}

function skillRelativePath(raw: string, fromFolder: string, linked: boolean): string | null {
  let target = raw.trim().replace(/[#?].*$/u, "").replace(/[.,;:]+$/u, "");
  if (!target || /^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("/") || target.startsWith("//")) return null;
  try {
    target = decodeURIComponent(target);
  } catch {
    return null;
  }
  const extension = target.split("/").at(-1)?.split(".").at(-1)?.toLowerCase() ?? "";
  if (!target.split("/").at(-1)?.includes(".") || !skillFileExtensions.has(extension)) return null;
  if (!linked && !target.includes("/")) return null;
  const parts: string[] = [];
  for (const part of `${linked ? fromFolder : ""}${target}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const path = parts.join("/");
  return path && path !== "SKILL.md" && isSafeSkillPath(path) ? path : null;
}

export function isSafeSkillPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= pathMaxLength &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

export async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("skill_source_too_large");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) throw new Error("skill_source_too_large");
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Reads a linked Skill's SKILL.md and the files its own text names. A link
 * that names a file the host cannot return is reported in `missingFiles`.
 */
export async function fetchSkillFromUrl(reference: string, options: FetchSkillOptions = {}): Promise<FetchedSkill> {
  const fetcher = options.fetch ?? fetch.bind(globalThis);
  const ruleset = options.ruleset ?? "v1";
  const manifest = skillManifestAddress(skillLinkUrl(reference));
  const manifestResponse = await fetcher(manifest.url.href);
  if (manifestResponse.status === 404) throw new Error("skill_manifest_missing");
  if (!manifestResponse.ok) throw new Error("skill_source_unavailable");
  const manifestBytes = await readBoundedBytes(manifestResponse, bundleMaxBytes);
  let manifestText: string;
  try {
    manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
  } catch {
    throw new Error("skill_manifest_encoding_invalid");
  }

  const files: SkillInputFile[] = [{ path: "SKILL.md", bytes: manifestBytes }];
  const missingFiles: SkillMissingFile[] = [];
  const seen = new Set<string>(["SKILL.md"]);
  // Paths some text named by a link or a path with a folder, not only as a bare name.
  const namedPlainly = new Set<string>();
  const queue: NamedSkillFile[] = [];
  const enqueue = (found: readonly NamedSkillFile[]): void => {
    for (const file of found) if (!file.bareName) namedPlainly.add(file.path);
    queue.push(...found);
  };
  enqueue(namedSkillFileRefs(manifestText, "", { ruleset }));
  let totalBytes = manifestBytes.byteLength;
  while (queue.length > 0) {
    const path = queue.shift()?.path ?? "";
    if (seen.has(path)) continue;
    seen.add(path);
    if (files.length + missingFiles.length >= bundleMaxFiles) throw new Error("skill_source_too_large");
    if (!isSafeSkillPath(path)) {
      missingFiles.push({ path, reason: "unsafe_path" });
      continue;
    }
    let response: Response;
    try {
      response = await fetcher(new URL(path.split("/").map(encodeURIComponent).join("/"), manifest.folder).href);
    } catch {
      missingFiles.push({ path, reason: "unavailable" });
      continue;
    }
    if (response.status === 404) {
      missingFiles.push({ path, reason: "not_found" });
      continue;
    }
    if (!response.ok) {
      missingFiles.push({ path, reason: "unavailable" });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBytes(response, bundleMaxBytes - totalBytes);
    } catch (error) {
      if (error instanceof Error && error.message === "skill_source_too_large") {
        missingFiles.push({ path, reason: "too_large" });
        continue;
      }
      throw error;
    }
    totalBytes += bytes.byteLength;
    files.push({ path, bytes });
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (/\.(?:md|markdown|txt)$/iu.test(path)) enqueue(namedSkillFileRefs(text, parentFolder(path), { ruleset }));
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    files,
    source: {
      link: reference.trim(),
      catalog: manifest.sourceType === "github" ? "github" : "web",
      catalog_review: "not_checked",
    },
    // v2: a file no text named plainly, that the host did not find, was named only as a bare word.
    missingFiles:
      ruleset === "v2"
        ? missingFiles.map((file) =>
            file.reason === "not_found" && !namedPlainly.has(file.path) ? { ...file, bareName: true as const } : file,
          )
        : missingFiles,
  };
}
