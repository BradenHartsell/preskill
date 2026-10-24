/**
 * Text detection. A file is read whenever anything can read it, in the
 * encodings files actually use. Only bytes that fit none are binary.
 */

const windows1252 = new TextDecoder("windows-1252");

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

function hasBinaryControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d && code !== 0x1b) {
      return true;
    }
  }
  return false;
}

function decodeStrict(encoding: string, bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return hasBinaryControl(text) ? null : text;
  } catch {
    return null;
  }
}

/**
 * Text in the encodings files actually use. A UTF-16 byte-order mark, or a
 * UTF-16 shape (zero bytes at every other position), decodes as UTF-16; valid
 * UTF-8 decodes as UTF-8; otherwise bytes with no control characters beyond
 * tab and line breaks decode as Windows-1252. Only what fits none is binary.
 */
export function decodeSkillText(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return decodeStrict("utf-8", bytes.subarray(3));
  if (startsWith(bytes, [0xff, 0xfe])) return decodeStrict("utf-16le", bytes.subarray(2));
  if (startsWith(bytes, [0xfe, 0xff])) return decodeStrict("utf-16be", bytes.subarray(2));
  const pairs = Math.floor(bytes.length / 2);
  if (pairs >= 4) {
    let evenZeros = 0;
    let oddZeros = 0;
    for (let index = 0; index + 1 < bytes.length; index += 2) {
      if (bytes[index] === 0) evenZeros += 1;
      if (bytes[index + 1] === 0) oddZeros += 1;
    }
    if (oddZeros > pairs * 0.4 && evenZeros < pairs * 0.05) return decodeStrict("utf-16le", bytes);
    if (evenZeros > pairs * 0.4 && oddZeros < pairs * 0.05) return decodeStrict("utf-16be", bytes);
  }
  if (bytes.some((byte) => byte === 0)) return null;
  const asUtf8 = decodeStrict("utf-8", bytes);
  if (asUtf8 !== null) return asUtf8;
  const controls = bytes.filter(
    (byte) => byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d && byte !== 0x1b,
  ).length;
  return controls === 0 ? windows1252.decode(bytes) : null;
}

/** SKILL.md must be UTF-8 text; an encoding that is only guessed is not a manifest. */
export function decodeManifestText(bytes: Uint8Array): string {
  const withoutBom = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? bytes.subarray(3) : bytes;
  return new TextDecoder("utf-8", { fatal: true }).decode(withoutBom);
}

/**
 * The names, constants and text compiled bytecode carries: runs of printable
 * characters four or longer, the way a strings view of a .pyc or .class shows
 * the calls, addresses and literals the program uses.
 */
export function bytecodeStrings(bytes: Uint8Array): string {
  const decoder = new TextDecoder();
  const runs: string[] = [];
  let runStart = -1;
  for (let index = 0; index <= bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte !== undefined && byte >= 0x20 && byte < 0x7f) {
      if (runStart < 0) runStart = index;
      continue;
    }
    if (runStart >= 0 && index - runStart >= 4) runs.push(decoder.decode(bytes.subarray(runStart, index)));
    runStart = -1;
  }
  return runs.join("\n");
}

export function extensionOf(path: string): string {
  const name = path.split("/").at(-1) ?? "";
  return name.includes(".") ? (name.split(".").at(-1) ?? "").toLowerCase() : "";
}
