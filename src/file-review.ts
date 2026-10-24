/**
 * Every file in a Skill is read the way an agent would read it:
 *
 * - text in any common encoding (UTF-8, UTF-16 with or without a BOM,
 *   Windows-1252);
 * - documents when their own text can be extracted, or through an optional
 *   reader supplied by the host;
 * - archives (zip, jar, wheel, tar, gzip) unpacked within size, count, depth
 *   and path limits, every entry judged like any other file;
 * - compiled bytecode (.pyc, .class, .dex) judged by the names and strings it
 *   carries.
 *
 * Refusal stays only where nothing can say what a file does: a compiled native
 * program, a damaged or password-protected archive or document, an unknown
 * binary the Skill uses, or a file type with no reader. Each refusal names the
 * file and says why. Images, fonts, audio and video the Skill never names are
 * data assets, named to the check.
 *
 * One deterministic rule runs before the model: code that is decoded and then
 * run is refused outright. Base64 data assets and the transport encoding of
 * binary resources are not code and are never matched.
 */

import {
  ArchiveError,
  archiveEntries,
  archiveLimits,
  safeEntryPath,
  unzip,
  type ArchiveBudget,
  type ArchiveEntry,
} from "./archive.js";
import {
  bytecodeExtensions,
  dataAssetExtensions,
  documentMimeTypes,
  imageMimeTypes,
  nativeProgramExtensions,
  zipDocumentExtensions,
} from "./mime.js";
import { bytecodeStrings, decodeSkillText, extensionOf } from "./text.js";
import type {
  ParsedSkill,
  SkillCheckFile,
  SkillFileReader,
  SkillFileRefusal,
  SkillFileRole,
  SkillFilesForCheck,
  SkillInputFile,
} from "./types.js";
import { SkillReaderError } from "./types.js";

import { namedSkillFiles } from "./fetch.js";

const nativeMagic: readonly (readonly number[])[] = [
  [0x4d, 0x5a],
  [0x7f, 0x45, 0x4c, 0x46],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xfe, 0xed, 0xfa, 0xce],
  [0x00, 0x61, 0x73, 0x6d],
];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

function roleOf(path: string): SkillFileRole {
  if (path.startsWith("scripts/")) return "script";
  if (path.startsWith("references/")) return "reference";
  if (path.startsWith("assets/")) return "asset";
  return "other file";
}

/** Every path the Skill's own text names, by path or by file name. */
function namedPaths(paths: readonly string[], texts: readonly string[]): Set<string> {
  const named = new Set(texts.flatMap((text) => namedSkillFiles(text, "")));
  for (const path of paths) {
    const name = path.split("/").at(-1) ?? "";
    if (name && texts.some((text) => text.includes(name))) named.add(path);
  }
  return named;
}

function refusal(path: string, code: SkillFileRefusal["code"]): SkillFileRefusal {
  const reason = (() => {
    switch (code) {
      case "compiled native program":
        return `${path} is a compiled program, so nobody can read what it would do.`;
      case "damaged or password-protected":
        return `${path} could not be opened: it is damaged or password-protected.`;
      case "unknown binary format":
        return `${path} is in a format nothing can read, and the Skill would have the agent use it.`;
      case "archive too large or too deep":
        return `${path} unpacks to more files or data than one Skill can hold, or nests archives too deeply.`;
      case "unsafe path":
        return `${path} contains a path that climbs out of the Skill, so it cannot be read safely.`;
      case "unreadable file type":
        return `${path} is a file type this scanner cannot read, and the Skill uses it.`;
      case "symlink":
        return `${path} is a symbolic link, which cannot be judged.`;
    }
  })();
  return { path, code, reason };
}

function stripXml(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&")
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/gu, " ")
    .trim();
}

/** Text from a ZIP-based office document, without any external reader. */
function officeDocumentText(bytes: Uint8Array, extension: string): string | null {
  if (!zipDocumentExtensions.has(extension)) return null;
  let entries: ArchiveEntry[];
  try {
    entries = unzip(bytes, { bytes: 0, entries: 0 });
  } catch {
    return null;
  }
  const wanted = (path: string): boolean => {
    if (extension === "docx") return path.startsWith("word/") && path.endsWith(".xml");
    if (extension === "xlsx") return path.startsWith("xl/") && path.endsWith(".xml");
    if (extension === "pptx") return path.startsWith("ppt/") && path.endsWith(".xml");
    return path === "content.xml";
  };
  const parts: string[] = [];
  for (const entry of entries) {
    if (!wanted(entry.path)) continue;
    const text = decodeSkillText(entry.bytes);
    if (text === null) continue;
    const stripped = stripXml(text);
    if (stripped) parts.push(stripped);
  }
  const joined = parts.join("\n").trim();
  return joined ? joined : null;
}

/** Text from an RTF document, without any external reader. */
function rtfText(bytes: Uint8Array): string | null {
  const raw = decodeSkillText(bytes);
  if (raw === null) return null;
  const text = raw
    .replace(/\\'[0-9a-f]{2}/giu, " ")
    .replace(/\\[a-z]+-?\d* ?/giu, " ")
    .replace(/[{}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return text ? text : null;
}

/** Extract text from a document this scanner can read without a model. */
function builtInDocumentText(bytes: Uint8Array, extension: string): string | null {
  if (zipDocumentExtensions.has(extension)) return officeDocumentText(bytes, extension);
  if (extension === "rtf") return rtfText(bytes);
  return null;
}

/**
 * Reads every file in the Skill and lists the few nobody can read. A reader
 * outage throws, so the check fails closed rather than skipping a file.
 */
export async function skillFilesForCheck(
  skill: ParsedSkill,
  inputFiles: readonly SkillInputFile[],
  reader?: SkillFileReader,
): Promise<SkillFilesForCheck> {
  const resources = inputFiles
    .filter((file) => file.path !== "SKILL.md")
    .sort((left, right) => left.path.localeCompare(right.path));
  const plainTexts = [
    skill.bodyMarkdown,
    ...resources.map((file) => decodeSkillText(file.bytes)).filter((text): text is string => text !== null),
  ];
  const named = namedPaths(
    resources.map((file) => file.path),
    plainTexts,
  );
  const files: SkillCheckFile[] = [];
  const dataAssets: string[] = [];
  const refusals: SkillFileRefusal[] = [];
  const budget: ArchiveBudget = { bytes: 0, entries: 0 };

  const readDocument = async (bytes: Uint8Array, mimeType: string, path: string): Promise<string | null> => {
    if (!reader?.documentText) return null;
    try {
      return await reader.documentText(bytes, mimeType, path);
    } catch {
      throw new SkillReaderError();
    }
  };
  const readVisual = async (input: { bytes: Uint8Array; mimeType: string; path: string }): Promise<string> => {
    if (!reader?.describeVisual) throw new SkillReaderError();
    try {
      return await reader.describeVisual(input);
    } catch {
      throw new SkillReaderError();
    }
  };

  const visit = async (
    path: string,
    bytes: Uint8Array,
    depth: number,
    isNamed: boolean,
    insideArchive: boolean,
  ): Promise<void> => {
    const extension = extensionOf(path);
    const role = roleOf(path.split("!/").at(-1) ?? path);
    const text = decodeSkillText(bytes);

    if (text !== null && !documentMimeTypes[extension]) {
      files.push({ path, role, readAs: insideArchive ? "archive entry text" : "text", text });
      return;
    }

    const documentMimeType = documentMimeTypes[extension];
    if (documentMimeType) {
      if (reader?.documentText) {
        const extracted = await readDocument(bytes, documentMimeType, path);
        if (extracted !== null) {
          files.push({ path, role, readAs: "document text", text: extracted });
          return;
        }
      }
      if (documentMimeType === "application/pdf") {
        if (reader?.describeVisual) {
          files.push({
            path,
            role,
            readAs: "visual reading",
            text: await readVisual({ bytes, mimeType: documentMimeType, path }),
          });
          return;
        }
      } else {
        const extracted = builtInDocumentText(bytes, extension);
        if (extracted !== null) {
          files.push({ path, role, readAs: "document text", text: extracted });
          return;
        }
        if (reader?.describeVisual) {
          files.push({
            path,
            role,
            readAs: "visual reading",
            text: await readVisual({ bytes, mimeType: documentMimeType, path }),
          });
          return;
        }
      }
      if (isNamed || insideArchive) refusals.push(refusal(path, "unreadable file type"));
      else dataAssets.push(path);
      return;
    }

    if (nativeProgramExtensions.has(extension) || nativeMagic.some((magic) => startsWith(bytes, magic))) {
      refusals.push(refusal(path, "compiled native program"));
      return;
    }

    if (bytecodeExtensions.has(extension)) {
      files.push({ path, role, readAs: "bytecode strings", text: bytecodeStrings(bytes) });
      return;
    }

    const imageMimeType = imageMimeTypes[extension];
    if (imageMimeType && isNamed) {
      if (reader?.describeVisual) {
        files.push({
          path,
          role,
          readAs: "visual reading",
          text: await readVisual({ bytes, mimeType: imageMimeType, path }),
        });
        return;
      }
      refusals.push(refusal(path, "unreadable file type"));
      return;
    }

    if (dataAssetExtensions.has(extension)) {
      dataAssets.push(path);
      return;
    }

    let entries: ArchiveEntry[] | null;
    try {
      entries = archiveEntries(path, bytes, budget);
      if (entries && depth >= archiveLimits.maxDepth) {
        throw new ArchiveError("archive too large or too deep");
      }
    } catch (error) {
      if (!(error instanceof ArchiveError)) throw error;
      refusals.push(refusal(path, error.reason));
      return;
    }
    if (entries) {
      for (const entry of entries.sort((left, right) => left.path.localeCompare(right.path))) {
        const entryPath = `${path}!/${entry.path}`;
        if (entry.symlink) {
          refusals.push(refusal(entryPath, "symlink"));
          continue;
        }
        await visit(entryPath, entry.bytes, depth + 1, true, true);
      }
      return;
    }

    // Refused only when the Skill uses it: named by its text, or packed in an
    // archive it names. Sitting under `scripts/` is not use.
    if (isNamed || insideArchive) refusals.push(refusal(path, "unknown binary format"));
    else dataAssets.push(path);
  };

  for (const resource of resources) {
    if (!safeEntryPath(resource.path)) {
      refusals.push(refusal(resource.path, "unknown binary format"));
      continue;
    }
    await visit(resource.path, resource.bytes, 0, named.has(resource.path), false);
  }
  return { files, dataAssets, refusals };
}

/**
 * Text that is decoded and then run, in the forms code and shells use. Each
 * pattern needs both halves, a decoder and an execution sink, so a base64
 * image, a hash, or prose about encoding never matches.
 */
const decoder =
  String.raw`(?:b64decode|b32decode|b16decode|a85decode|b85decode|decodebytes|decodestring|fromhex|unhexlify|atob|FromBase64String|codecs\.decode|zlib\.decompress|marshal\.loads|Buffer\.from\([^)]*?['"](?:base64|hex)['"])`;
const sink =
  String.raw`(?:\bexec|\beval|\bFunction|\bcompile|\bInvoke-Expression|\biex|\bexecSync|\bspawnSync|\bsubprocess\.\w+|\bos\.system|\bchild_process\.\w+)`;
const encodedCodePatterns: readonly RegExp[] = [
  // exec(base64.b64decode(...)), eval(atob(...)), new Function(Buffer.from(x, "base64").toString())
  new RegExp(String.raw`${sink}\s*\(?[^\n]{0,240}?${decoder}`, "iu"),
  // echo ... | base64 -d | sh ; xxd -r -p | bash ; openssl base64 -d | python
  /(?:\bbase64\s+(?:-d|-D|--decode)\b|\bxxd\s+-r\b|\bopenssl\s+(?:enc\s+)?-?base64\s+-d\b)[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|python3?|node|perl|ruby|php|pwsh|powershell)\b/iu,
  // eval "$(... base64 -d)", bash <(... base64 -d), sh -c "$(... | base64 -d)"
  /(?:\beval\s+["']?\$\(|\b(?:sh|bash|zsh)\s+(?:-c\s+["']?\$\(|<\())[^\n]{0,240}?(?:\bbase64\s+(?:-d|-D|--decode)\b|\bxxd\s+-r\b)/iu,
  // powershell -EncodedCommand <payload>
  /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*\s-(?:e|ec|en|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/iu,
];

/** A name assigned from a decoder and later run: `payload = base64.b64decode(...)` then `exec(payload)`. */
function decodedThenRun(text: string): boolean {
  const assigned = new RegExp(String.raw`\b([A-Za-z_$][\w$]*)\s*[:]?=\s*[^\n]{0,240}?${decoder}`, "giu");
  for (const match of text.matchAll(assigned)) {
    const name = match[1];
    if (!name) continue;
    const escaped = name.replace(/[$]/gu, "\\$");
    if (new RegExp(String.raw`${sink}\s*\(\s*(?:${escaped})\b`, "u").test(text)) return true;
  }
  return false;
}

/** The files whose text decodes and then runs code, in path order. */
export function skillEncodedCodeFiles(
  files: readonly { path: string; text: string }[],
): string[] {
  return files
    .filter(
      (file) =>
        encodedCodePatterns.some((pattern) => pattern.test(file.text)) || decodedThenRun(file.text),
    )
    .map((file) => file.path)
    .sort((left, right) => left.localeCompare(right));
}

export { refusal as skillFileRefusal, roleOf as skillFileRole };
