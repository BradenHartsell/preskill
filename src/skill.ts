/**
 * The small part of the Agent Skills manifest this scanner relies on: the
 * YAML frontmatter's `name`, `description`, optional license and compatibility,
 * and the Markdown body that follows. This is a deliberately small parser, not
 * a general YAML implementation; anything it cannot read is refused instead of
 * guessed at.
 */

import { decodeManifestText } from "./text.js";
import type { ParsedSkill, SkillInputFile } from "./types.js";

export class SkillFormatError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SkillFormatError";
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/gu, "\n")
      .replace(/\\t/gu, "\t")
      .replace(/\\"/gu, '"')
      .replace(/\\\\/gu, "\\");
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/gu, "'");
  }
  return trimmed;
}

/** Remove a YAML comment, respecting quoted strings. */
function stripComment(value: string): string {
  let quoted: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (character === quoted && value[index - 1] !== "\\") quoted = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quoted = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/u.test(value[index - 1] ?? ""))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

function indentOf(line: string): number {
  return line.match(/^ */u)?.[0].length ?? 0;
}

function foldBlock(lines: readonly string[]): string {
  let output = "";
  for (const line of lines) {
    if (line.trim() === "") {
      output = `${output.replace(/ +$/u, "")}\n`;
      continue;
    }
    const separator = output === "" || output.endsWith("\n") ? "" : " ";
    output += separator + line.trim();
  }
  return output;
}

function parseFrontmatter(header: string): Record<string, string> {
  const lines = header.split(/\r?\n/u);
  const fields: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim() || indentOf(line) > 0 || line.trimStart().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(key)) continue;
    const rest = stripComment(line.slice(colon + 1)).trim();
    const block = /^([|>])([+-]?)$/u.exec(rest);
    if (!block) {
      fields[key] = unquote(rest);
      continue;
    }
    const collected: string[] = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1] ?? "";
      if (next.trim() === "") {
        collected.push("");
        index += 1;
        continue;
      }
      if (indentOf(next) === 0) break;
      collected.push(next);
      index += 1;
    }
    while (collected.at(-1) === "") collected.pop();
    const indents = collected.filter((entry) => entry.trim()).map(indentOf);
    const base = indents.length > 0 ? Math.min(...indents) : 0;
    const stripped = collected.map((entry) => (entry.trim() ? entry.slice(base) : ""));
    let value = block[1] === "|" ? stripped.join("\n") : foldBlock(stripped);
    if (block[2] === "-") value = value.replace(/\n+$/u, "");
    else if (block[2] !== "+") value = `${value.replace(/\n+$/u, "")}\n`;
    fields[key] = value;
  }
  return fields;
}

export function slugifySkillName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replace(/-+$/gu, "");
}

/**
 * Parse SKILL.md and the folder beside it.
 *
 * `lenientName` reads a title-style name ("SharePoint Automation") in the
 * Agent Skills slug form, as a linked Skill is read. A folder imported by a
 * catalog can keep the strict form.
 */
export function parseSkillFolder(
  inputFiles: readonly SkillInputFile[],
  options: { lenientName?: boolean } = {},
): { skill: ParsedSkill; files: readonly SkillInputFile[] } {
  const files = normalizeFiles(inputFiles);
  const manifest = files.find((file) => file.path === "SKILL.md");
  if (!manifest) throw new SkillFormatError("skill_manifest_missing");
  let text: string;
  try {
    text = decodeManifestText(manifest.bytes);
  } catch {
    throw new SkillFormatError("skill_manifest_encoding_invalid");
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(text);
  if (!match) throw new SkillFormatError("skill_manifest_frontmatter_missing");
  const fields = parseFrontmatter(match[1] ?? "");
  const declaredName = requiredString(fields.name, "skill_manifest_name_invalid");
  const name = options.lenientName === false ? declaredName : slugifySkillName(declaredName);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name.length > 64) {
    throw new SkillFormatError("skill_manifest_name_invalid");
  }
  const description = requiredString(fields.description, "skill_manifest_description_invalid");
  if (description.length > 1024) throw new SkillFormatError("skill_manifest_description_invalid");
  const license = optionalString(fields.license);
  const compatibility = optionalString(fields.compatibility);
  if (compatibility && compatibility.length > 500) throw new SkillFormatError("skill_manifest_compatibility_invalid");
  return {
    skill: {
      name,
      description,
      bodyMarkdown: match[2] ?? "",
      ...(license ? { license } : {}),
      ...(compatibility ? { compatibility } : {}),
    },
    files,
  };
}

function normalizeFiles(inputFiles: readonly SkillInputFile[]): SkillInputFile[] {
  const files = inputFiles.map((file) => {
    const path = normalizeRelativePath(file.path);
    if (!(file.bytes instanceof Uint8Array)) throw new SkillFormatError("skill_file_contents_invalid");
    return { path, bytes: file.bytes };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new SkillFormatError("skill_source_duplicate_path");
  }
  return files;
}

function normalizeRelativePath(value: string): string {
  const path = requiredString(value, "skill_source_path_invalid");
  if (
    path.includes("\\") ||
    path.startsWith("/") ||
    path.includes("\u0000") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new SkillFormatError("skill_source_path_invalid");
  }
  return path;
}

function requiredString(value: unknown, error: string): string {
  if (typeof value !== "string" || !value.trim()) throw new SkillFormatError(error);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
