/**
 * Archive reading with fixed bounds: 16 MiB expanded, 256 entries,
 * depth 3, safe paths. ZIP (stored and deflate), tar and gzip are supported
 * with a small built-in inflater, so the core has no Node-only dependency.
 *
 * Nothing here executes archive content. A damaged, encrypted or unsupported
 * archive is refused, never guessed at.
 */

import { documentMimeTypes, zipExtensions } from "./mime.js";
import { extensionOf } from "./text.js";
import type { Ruleset } from "./types.js";

/** How an archive is read. Ruleset v2 adds the stricter rules marked "v2" below. */
export interface ArchiveReadOptions {
  readonly ruleset?: Ruleset;
}

export const archiveLimits = {
  maxExpandedBytes: 16 * 1024 * 1024,
  maxEntries: 256,
  maxDepth: 3,
} as const;

export type ArchiveRefusalReason =
  | "damaged or password-protected"
  | "archive too large or too deep"
  | "unsafe path"
  /** v2: an archive or compression format this reader does not unpack. */
  | "archive format this check cannot open"
  /** v2: a tar header that renames or reshapes entries in a way this reader cannot follow. */
  | "archive feature that cannot be checked";

export class ArchiveError extends Error {
  constructor(readonly reason: ArchiveRefusalReason) {
    super(`archive_${reason.replaceAll(" ", "_")}`);
    this.name = "ArchiveError";
  }
}

export interface ArchiveBudget {
  bytes: number;
  entries: number;
}

export interface ArchiveEntry {
  path: string;
  bytes: Uint8Array;
  /** A ZIP or tar symbolic link. It is refused, never followed. */
  symlink?: boolean;
}

function claim(budget: ArchiveBudget, bytes: number): void {
  budget.entries += 1;
  budget.bytes += bytes;
  if (budget.entries > archiveLimits.maxEntries || budget.bytes > archiveLimits.maxExpandedBytes) {
    throw new ArchiveError("archive too large or too deep");
  }
}

/** Normalize an entry path; null for an absolute path, a drive letter, or a climb out. */
export function safeEntryPath(name: string): string | null {
  const parts: string[] = [];
  for (const part of name.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.length === 0 || name.startsWith("/") || /^[A-Za-z]:/u.test(name) ? null : parts.join("/");
}

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

// ---------------------------------------------------------------------------
// CRC32, for gzip
// ---------------------------------------------------------------------------

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// DEFLATE
// ---------------------------------------------------------------------------

class BitReader {
  private bitBuffer = 0;
  private bitCount = 0;
  position = 0;

  constructor(private readonly bytes: Uint8Array) {}

  readBits(count: number): number {
    while (this.bitCount < count) {
      if (this.position >= this.bytes.length) throw new ArchiveError("damaged or password-protected");
      this.bitBuffer |= this.bytes[this.position]! << this.bitCount;
      this.position += 1;
      this.bitCount += 8;
    }
    const value = this.bitBuffer & ((1 << count) - 1);
    this.bitBuffer >>>= count;
    this.bitCount -= count;
    return value;
  }

  alignToByte(): void {
    this.bitBuffer = 0;
    this.bitCount = 0;
  }

  readBytes(count: number): Uint8Array {
    if (this.position + count > this.bytes.length) throw new ArchiveError("damaged or password-protected");
    const value = this.bytes.subarray(this.position, this.position + count);
    this.position += count;
    return value;
  }
}

interface Huffman {
  readonly codes: ReadonlyMap<number, number>;
  readonly maxBits: number;
}

function reverseBits(value: number, length: number): number {
  let reversed = 0;
  for (let index = 0; index < length; index += 1) {
    reversed = (reversed << 1) | ((value >>> index) & 1);
  }
  return reversed;
}

function buildHuffman(lengths: readonly number[]): Huffman {
  const counts = new Array<number>(16).fill(0);
  for (const length of lengths) {
    if (!Number.isInteger(length) || length < 0 || length > 15) throw new ArchiveError("damaged or password-protected");
    if (length > 0) counts[length] = (counts[length] ?? 0) + 1;
  }
  // Over-subscribed trees are invalid; incomplete trees are legal in DEFLATE.
  let left = 1;
  for (let length = 1; length <= 15; length += 1) {
    left = (left << 1) - (counts[length] ?? 0);
    if (left < 0) throw new ArchiveError("damaged or password-protected");
  }
  const nextCode = new Array<number>(16).fill(0);
  let code = 0;
  for (let length = 1; length <= 15; length += 1) {
    code = (code + (counts[length - 1] ?? 0)) << 1;
    nextCode[length] = code;
  }
  const codes = new Map<number, number>();
  let maxBits = 0;
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol] ?? 0;
    if (length === 0) continue;
    const canonical = nextCode[length]!;
    nextCode[length] = canonical + 1;
    codes.set((length << 16) | reverseBits(canonical, length), symbol);
    if (length > maxBits) maxBits = length;
  }
  return { codes, maxBits };
}

function decodeSymbol(reader: BitReader, huffman: Huffman): number {
  let code = 0;
  for (let length = 1; length <= huffman.maxBits; length += 1) {
    code |= reader.readBits(1) << (length - 1);
    const symbol = huffman.codes.get((length << 16) | code);
    if (symbol !== undefined) return symbol;
  }
  throw new ArchiveError("damaged or password-protected");
}

const lengthBase = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163,
  195, 227, 258,
] as const;
const lengthExtra = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
] as const;
const distanceBase = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
] as const;
const distanceExtra = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
] as const;

function fixedTrees(): { literal: Huffman; distance: Huffman } {
  const literalLengths = new Array<number>(288).fill(0);
  for (let symbol = 0; symbol <= 143; symbol += 1) literalLengths[symbol] = 8;
  for (let symbol = 144; symbol <= 255; symbol += 1) literalLengths[symbol] = 9;
  for (let symbol = 256; symbol <= 279; symbol += 1) literalLengths[symbol] = 7;
  for (let symbol = 280; symbol <= 287; symbol += 1) literalLengths[symbol] = 8;
  return {
    literal: buildHuffman(literalLengths),
    distance: buildHuffman(new Array<number>(32).fill(5)),
  };
}

const fixed = fixedTrees();

const codeLengthOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15] as const;

function dynamicTrees(reader: BitReader): { literal: Huffman; distance: Huffman } {
  const literalCount = reader.readBits(5) + 257;
  const distanceCount = reader.readBits(5) + 1;
  const codeLengthCount = reader.readBits(4) + 4;
  if (literalCount > 286 || distanceCount > 32) throw new ArchiveError("damaged or password-protected");
  const codeLengths = new Array<number>(19).fill(0);
  for (let index = 0; index < codeLengthCount; index += 1) {
    codeLengths[codeLengthOrder[index]!] = reader.readBits(3);
  }
  const codeLengthTree = buildHuffman(codeLengths);
  const lengths: number[] = [];
  while (lengths.length < literalCount + distanceCount) {
    const symbol = decodeSymbol(reader, codeLengthTree);
    if (symbol <= 15) {
      lengths.push(symbol);
    } else if (symbol === 16) {
      const previous = lengths.at(-1);
      if (previous === undefined) throw new ArchiveError("damaged or password-protected");
      const repeat = 3 + reader.readBits(2);
      for (let index = 0; index < repeat; index += 1) lengths.push(previous);
    } else if (symbol === 17) {
      const repeat = 3 + reader.readBits(3);
      for (let index = 0; index < repeat; index += 1) lengths.push(0);
    } else if (symbol === 18) {
      const repeat = 11 + reader.readBits(7);
      for (let index = 0; index < repeat; index += 1) lengths.push(0);
    } else {
      throw new ArchiveError("damaged or password-protected");
    }
    if (lengths.length > literalCount + distanceCount) throw new ArchiveError("damaged or password-protected");
  }
  const literalLengths = lengths.slice(0, literalCount);
  const distanceLengths = lengths.slice(literalCount);
  if ((literalLengths[256] ?? 0) === 0) throw new ArchiveError("damaged or password-protected");
  return {
    literal: buildHuffman(literalLengths),
    distance: buildHuffman(distanceLengths),
  };
}

function inflateBlockBody(
  reader: BitReader,
  literal: Huffman,
  distance: Huffman,
  output: Uint8Array,
  start: number,
): number {
  let position = start;
  for (;;) {
    const symbol = decodeSymbol(reader, literal);
    if (symbol < 256) {
      if (position >= output.length) throw new ArchiveError("archive too large or too deep");
      output[position] = symbol;
      position += 1;
      continue;
    }
    if (symbol === 256) return position;
    if (symbol < 257 || symbol > 285) throw new ArchiveError("damaged or password-protected");
    const lengthIndex = symbol - 257;
    const length = lengthBase[lengthIndex]! + reader.readBits(lengthExtra[lengthIndex]!);
    const distanceSymbol = decodeSymbol(reader, distance);
    if (distanceSymbol > 29) throw new ArchiveError("damaged or password-protected");
    const copyDistance = distanceBase[distanceSymbol]! + reader.readBits(distanceExtra[distanceSymbol]!);
    if (copyDistance > position) throw new ArchiveError("damaged or password-protected");
    if (position + length > output.length) throw new ArchiveError("archive too large or too deep");
    for (let index = 0; index < length; index += 1) {
      output[position] = output[position - copyDistance]!;
      position += 1;
    }
  }
}

/** Raw DEFLATE decompression with a hard output bound. */
export function inflateRaw(bytes: Uint8Array, maxOutput: number): Uint8Array {
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 0) throw new ArchiveError("archive too large or too deep");
  const reader = new BitReader(bytes);
  const output = new Uint8Array(maxOutput);
  let position = 0;
  let blocks = 0;
  for (;;) {
    blocks += 1;
    if (blocks > 1_000_000) throw new ArchiveError("damaged or password-protected");
    const final = reader.readBits(1);
    const type = reader.readBits(2);
    if (type === 0) {
      reader.alignToByte();
      const length = reader.readBits(16);
      const complement = reader.readBits(16);
      if ((length ^ 0xffff) !== complement) throw new ArchiveError("damaged or password-protected");
      if (position + length > output.length) throw new ArchiveError("archive too large or too deep");
      output.set(reader.readBytes(length), position);
      position += length;
    } else if (type === 1) {
      position = inflateBlockBody(reader, fixed.literal, fixed.distance, output, position);
    } else if (type === 2) {
      const trees = dynamicTrees(reader);
      position = inflateBlockBody(reader, trees.literal, trees.distance, output, position);
    } else {
      throw new ArchiveError("damaged or password-protected");
    }
    if (final === 1) return output.slice(0, position);
  }
}

// ---------------------------------------------------------------------------
// gzip
// ---------------------------------------------------------------------------

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

export function gunzip(bytes: Uint8Array, maxOutput: number): Uint8Array {
  if (!startsWith(bytes, [0x1f, 0x8b]) || bytes.length < 18) throw new ArchiveError("damaged or password-protected");
  if (bytes[2] !== 8) throw new ArchiveError("damaged or password-protected");
  const flags = bytes[3] ?? 0;
  if ((flags & 0xe0) !== 0) throw new ArchiveError("damaged or password-protected");
  let position = 10;
  const skipNullTerminated = (): void => {
    while (position < bytes.length && bytes[position] !== 0) position += 1;
    if (position >= bytes.length) throw new ArchiveError("damaged or password-protected");
    position += 1;
  };
  if ((flags & 0x04) !== 0) {
    if (position + 2 > bytes.length) throw new ArchiveError("damaged or password-protected");
    const extraLength = (bytes[position] ?? 0) | ((bytes[position + 1] ?? 0) << 8);
    position += 2 + extraLength;
    if (position > bytes.length) throw new ArchiveError("damaged or password-protected");
  }
  if ((flags & 0x08) !== 0) skipNullTerminated();
  if ((flags & 0x10) !== 0) skipNullTerminated();
  if ((flags & 0x02) !== 0) {
    position += 2;
    if (position > bytes.length) throw new ArchiveError("damaged or password-protected");
  }
  const dataEnd = bytes.length - 8;
  if (dataEnd < position) throw new ArchiveError("damaged or password-protected");
  const output = inflateRaw(bytes.subarray(position, dataEnd), maxOutput);
  const expectedCrc = readU32LE(bytes, dataEnd);
  const expectedSize = readU32LE(bytes, dataEnd + 4);
  if ((output.length >>> 0) !== expectedSize || crc32(output) !== expectedCrc) {
    throw new ArchiveError("damaged or password-protected");
  }
  return output;
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06
    ) {
      return offset;
    }
  }
  return -1;
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

export function unzip(bytes: Uint8Array, budget: ArchiveBudget): ArchiveEntry[] {
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) throw new ArchiveError("damaged or password-protected");
  const disk = readU16LE(bytes, eocd + 4);
  const centralDisk = readU16LE(bytes, eocd + 6);
  const total = readU16LE(bytes, eocd + 10);
  const centralSize = readU32LE(bytes, eocd + 12);
  const centralOffset = readU32LE(bytes, eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || total === 0xffff || centralOffset === 0xffffffff) {
    throw new ArchiveError("damaged or password-protected");
  }
  if (centralOffset + centralSize > bytes.length) throw new ArchiveError("damaged or password-protected");
  if (total === 0) {
    if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) throw new ArchiveError("damaged or password-protected");
    return [];
  }
  const entries = new Map<string, ArchiveEntry>();
  let offset = centralOffset;
  for (let index = 0; index < total; index += 1) {
    if (
      offset + 46 > bytes.length ||
      bytes[offset] !== 0x50 ||
      bytes[offset + 1] !== 0x4b ||
      bytes[offset + 2] !== 0x01 ||
      bytes[offset + 3] !== 0x02
    ) {
      throw new ArchiveError("damaged or password-protected");
    }
    const expectedCrc = readU32LE(bytes, offset + 16);
    const flags = readU16LE(bytes, offset + 8);
    const method = readU16LE(bytes, offset + 10);
    const compressedSize = readU32LE(bytes, offset + 20);
    const uncompressedSize = readU32LE(bytes, offset + 24);
    const nameLength = readU16LE(bytes, offset + 28);
    const extraLength = readU16LE(bytes, offset + 30);
    const commentLength = readU16LE(bytes, offset + 32);
    const localOffset = readU32LE(bytes, offset + 42);
    const externalAttributes = readU32LE(bytes, offset + 38);
    const symlink = ((externalAttributes >>> 16) & 0xf000) === 0xa000;
    if (offset + 46 + nameLength + extraLength + commentLength > bytes.length) {
      throw new ArchiveError("damaged or password-protected");
    }
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = new TextDecoder("utf-8").decode(nameBytes);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if ((flags & 0x0001) !== 0) throw new ArchiveError("damaged or password-protected");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new ArchiveError("archive too large or too deep");
    }
    if (uncompressedSize > archiveLimits.maxExpandedBytes - budget.bytes) {
      throw new ArchiveError("archive too large or too deep");
    }
    const path = safeEntryPath(name);
    if (path === null) throw new ArchiveError("unsafe path");
    if (
      localOffset + 30 > bytes.length ||
      bytes[localOffset] !== 0x50 ||
      bytes[localOffset + 1] !== 0x4b ||
      bytes[localOffset + 2] !== 0x03 ||
      bytes[localOffset + 3] !== 0x04
    ) {
      throw new ArchiveError("damaged or password-protected");
    }
    const localNameLength = readU16LE(bytes, localOffset + 26);
    const localExtraLength = readU16LE(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > bytes.length) throw new ArchiveError("damaged or password-protected");
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let data: Uint8Array;
    if (method === 0) {
      data = compressed.slice();
    } else if (method === 8) {
      data = inflateRaw(compressed, Math.min(uncompressedSize, archiveLimits.maxExpandedBytes - budget.bytes));
    } else {
      throw new ArchiveError("damaged or password-protected");
    }
    if (data.length !== uncompressedSize) throw new ArchiveError("damaged or password-protected");
    if (crc32(data) !== expectedCrc) throw new ArchiveError("damaged or password-protected");
    claim(budget, data.length);
    entries.set(path, { path, bytes: data, ...(symlink ? { symlink: true } : {}) });
  }
  return [...entries.values()];
}

// ---------------------------------------------------------------------------
// tar
// ---------------------------------------------------------------------------

function field(bytes: Uint8Array, offset: number, length: number): string {
  return new TextDecoder("latin1").decode(bytes.subarray(offset, offset + length)).replace(/\0.*$/su, "");
}

function isTar(bytes: Uint8Array): boolean {
  return bytes.length >= 512 && new TextDecoder("latin1").decode(bytes.subarray(257, 262)) === "ustar";
}

export function untar(bytes: Uint8Array, budget: ArchiveBudget, options: ArchiveReadOptions = {}): ArchiveEntry[] {
  if (options.ruleset === "v2") return untarV2(bytes, budget);
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    if (bytes.subarray(offset, offset + 512).every((byte) => byte === 0)) break;
    const storedChecksum = Number.parseInt(field(bytes, offset + 148, 8).trim(), 8);
    let computedChecksum = 0;
    for (let index = 0; index < 512; index += 1) {
      computedChecksum += index >= 148 && index < 156 ? 0x20 : (bytes[offset + index] ?? 0);
    }
    if (!Number.isSafeInteger(storedChecksum) || storedChecksum !== computedChecksum) {
      throw new ArchiveError("damaged or password-protected");
    }
    const size = Number.parseInt(field(bytes, offset + 124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.length) {
      throw new ArchiveError("damaged or password-protected");
    }
    const prefix = field(bytes, offset + 345, 155);
    const name = prefix ? `${prefix}/${field(bytes, offset, 100)}` : field(bytes, offset, 100);
    const type = String.fromCharCode(bytes[offset + 156] ?? 0);
    if (type === "0" || type === "\0") {
      const path = safeEntryPath(name);
      if (path === null) throw new ArchiveError("unsafe path");
      claim(budget, size);
      entries.push({ path, bytes: bytes.slice(offset + 512, offset + 512 + size) });
    } else if (type === "1" || type === "2") {
      const path = safeEntryPath(name);
      if (path === null) throw new ArchiveError("unsafe path");
      claim(budget, 0);
      entries.push({ path, bytes: new Uint8Array(), symlink: true });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// tar, ruleset v2
// ---------------------------------------------------------------------------

/**
 * v2: whether a tar header's stored checksum matches its bytes. Some old tars
 * summed signed bytes, so either sum is accepted.
 */
function tarHeaderChecksumValid(bytes: Uint8Array, offset: number): boolean {
  const expected = Number.parseInt(field(bytes, offset + 148, 8).trim(), 8);
  if (!Number.isSafeInteger(expected)) return false;
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < 512; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : (bytes[offset + index] ?? 0);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return expected === unsigned || expected === signed;
}

/** v2: a tar by its first header, the `ustar` magic or (a v7 tar, which has none) a valid checksum. */
function isTarV2(bytes: Uint8Array): boolean {
  if (isTar(bytes)) return true;
  return bytes.length >= 512 && !bytes.subarray(0, 512).every((byte) => byte === 0) && tarHeaderChecksumValid(bytes, 0);
}

/** A name that is the archive's own root (`.`, `./`), not absolute and with no `..`. */
function isRootName(name: string): boolean {
  const slashed = name.replaceAll("\\", "/");
  return !slashed.startsWith("/") && slashed.split("/").every((part) => part === "" || part === ".");
}

/** The records of a pax extended header (`<length> <key>=<value>\n`), or null when one is malformed. */
function paxRecords(data: Uint8Array): Map<string, string> | null {
  const records = new Map<string, string>();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset < data.length && data[offset] !== 0) {
    let space = offset;
    while (space < data.length && data[space] !== 0x20) space += 1;
    const digits = decoder.decode(data.subarray(offset, space));
    const length = /^\d{1,9}$/u.test(digits) ? Number(digits) : Number.NaN;
    if (
      !Number.isSafeInteger(length) ||
      length <= space - offset + 1 ||
      offset + length > data.length ||
      data[offset + length - 1] !== 0x0a
    ) {
      return null;
    }
    const record = decoder.decode(data.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf("=");
    if (equals <= 0) return null;
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

/**
 * v2: walks every tar header, applying pax (`x`/`X`: `path`, `size`) and GNU
 * long-name (`L`, `K`) headers to the entry they precede, as real tar does,
 * so a header that renames an entry is checked under the name it unpacks to.
 * Every name a reader could give an entry must be a safe path. Anything this
 * walk would follow differently from tar is refused rather than guessed: two
 * extended headers of one kind in a row, a pax name and a long name that
 * disagree, a global pax header that renames or resizes, a link, directory,
 * device or pipe that claims data, and GNU sparse files. Directories, devices
 * and pipes hold no content; links are refused as in v1; any other type
 * unpacks as a regular file, so it is judged as one.
 */
function untarV2(bytes: Uint8Array, budget: ArchiveBudget): ArchiveEntry[] {
  const unchecked = (): ArchiveError => new ArchiveError("archive feature that cannot be checked");
  const damaged = (): ArchiveError => new ArchiveError("damaged or password-protected");
  const cString = (data: Uint8Array): string => new TextDecoder().decode(data).replace(/\0.*$/su, "");
  const entries: ArchiveEntry[] = [];
  let pax: Map<string, string> | undefined;
  let longName: string | undefined;
  let longLink: string | undefined;
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    if (bytes.subarray(offset, offset + 512).every((byte) => byte === 0)) break;
    if (!tarHeaderChecksumValid(bytes, offset)) throw damaged();
    const sizeField = field(bytes, offset + 124, 12).trim();
    if (!/^[0-7]*$/u.test(sizeField)) throw damaged();
    const headerSize = Number.parseInt(sizeField || "0", 8);
    const type = String.fromCharCode(bytes[offset + 156] ?? 0);
    if ("xXgLK".includes(type)) {
      if (offset + 512 + headerSize > bytes.length) throw damaged();
      const data = bytes.subarray(offset + 512, offset + 512 + headerSize);
      if (type === "x" || type === "X" || type === "g") {
        const records = paxRecords(data);
        if (!records) throw damaged();
        if ([...records.keys()].some((key) => key.startsWith("GNU.sparse."))) throw unchecked();
        if (type === "g" && (records.has("path") || records.has("linkpath") || records.has("size"))) throw unchecked();
        if (type !== "g") {
          if (pax) throw unchecked();
          pax = records;
        }
      } else if (type === "L") {
        if (longName !== undefined) throw unchecked();
        longName = cString(data);
      } else {
        if (longLink !== undefined) throw unchecked();
        longLink = cString(data);
      }
      offset += 512 + Math.ceil(headerSize / 512) * 512;
      continue;
    }
    if (type === "S") throw unchecked();
    const paxSize = pax?.get("size");
    if (paxSize !== undefined && !/^\d{1,15}$/u.test(paxSize)) throw damaged();
    const size = paxSize === undefined ? headerSize : Number(paxSize);
    if (!Number.isSafeInteger(size) || offset + 512 + size > bytes.length) throw damaged();
    // Some readers skip no data after a link, directory, device or pipe whatever
    // its size says, others skip by size: a size there would hide headers from one of them.
    if ("123456".includes(type) && size > 0) throw unchecked();
    const prefix = field(bytes, offset + 345, 155);
    const rawName = field(bytes, offset, 100);
    const headerNames = prefix ? [`${prefix}/${rawName}`, rawName] : [rawName];
    const extendedNames = [pax?.get("path"), longName].filter((name): name is string => name !== undefined);
    const extendedTargets = [pax?.get("linkpath"), longLink].filter((target): target is string => target !== undefined);
    const safeExtended = extendedNames.map(safeEntryPath);
    if (new Set(safeExtended).size > 1 || new Set(extendedTargets).size > 1) throw unchecked();
    // Every name some reader would give this entry must stay inside the Skill.
    // A directory may be the archive's own root (`./`), which unpacks nowhere new.
    const paths = [...safeExtended, ...headerNames.map(safeEntryPath)];
    const isDirectory = type === "5";
    const names = [...extendedNames, ...headerNames];
    if (paths.some((path, index) => path === null && !(isDirectory && isRootName(names[index] ?? "")))) {
      throw new ArchiveError("unsafe path");
    }
    const path = paths[0];
    pax = undefined;
    longName = undefined;
    longLink = undefined;
    const dataStart = offset + 512;
    offset += 512 + Math.ceil(size / 512) * 512;
    if (isDirectory || type === "3" || type === "4" || type === "6") continue;
    if (path === null || path === undefined) throw new ArchiveError("unsafe path");
    if (type === "1" || type === "2") {
      claim(budget, 0);
      entries.push({ path, bytes: new Uint8Array(), symlink: true });
      continue;
    }
    claim(budget, size);
    entries.push({ path, bytes: bytes.slice(dataStart, dataStart + size) });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// formats this reader does not open, ruleset v2
// ---------------------------------------------------------------------------

/** Leading bytes of archive and compression formats this reader does not unpack (and the ISO 9660 volume marker). */
const unopenedArchiveMagic: readonly { readonly at: number; readonly magic: readonly number[] }[] = [
  { at: 0, magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] }, // 7z
  { at: 0, magic: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] }, // RAR 4 and 5
  { at: 0, magic: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] }, // xz
  { at: 0, magic: [0x28, 0xb5, 0x2f, 0xfd] }, // zstd
  { at: 0, magic: [0x4c, 0x5a, 0x49, 0x50] }, // lzip
  { at: 0, magic: [0x04, 0x22, 0x4d, 0x18] }, // lz4 frame
  { at: 0, magic: [0x1f, 0x9d] }, // Unix compress (.Z)
  { at: 0, magic: [0x4d, 0x53, 0x43, 0x46, 0, 0, 0, 0] }, // Microsoft cabinet
  { at: 0, magic: [0x78, 0x61, 0x72, 0x21] }, // xar (macOS .pkg)
  { at: 0, magic: [0x60, 0xea] }, // ARJ
  { at: 0, magic: [0xc7, 0x71] }, // cpio, binary, little-endian
  { at: 0, magic: [0x71, 0xc7] }, // cpio, binary, big-endian
  { at: 0, magic: [0x30, 0x37, 0x30, 0x37, 0x30] }, // cpio, ASCII ("07070")
  { at: 0, magic: [0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a] }, // ar ("!<arch>"), as in .deb
  { at: 32769, magic: [0x43, 0x44, 0x30, 0x30, 0x31] }, // ISO 9660 ("CD001")
];

/** v2: whether these bytes are an archive or compressed stream in a format this reader cannot open. */
export function unopenedArchiveFormat(bytes: Uint8Array): boolean {
  if (unopenedArchiveMagic.some(({ at, magic }) => magic.every((byte, index) => bytes[at + index] === byte))) return true;
  // bzip2: "BZh", a block size digit, then a block or end-of-stream marker, so text that starts "BZh" never matches.
  const bzipBlock = [0x31, 0x41, 0x59, 0x26, 0x53, 0x59];
  const bzipEnd = [0x17, 0x72, 0x45, 0x38, 0x50, 0x90];
  const level = bytes[3] ?? 0;
  return (
    startsWith(bytes, [0x42, 0x5a, 0x68]) &&
    level >= 0x31 &&
    level <= 0x39 &&
    [bzipBlock, bzipEnd].some((marker) => marker.every((byte, index) => bytes[4 + index] === byte))
  );
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Entries when `path` is an archive, null when it is not. Under ruleset v2 an
 * archive or compression format this reader cannot open is refused by its
 * bytes, whatever its name, and a v7 tar (no `ustar` magic) is recognized by
 * its header checksum.
 */
export function archiveEntries(
  path: string,
  bytes: Uint8Array,
  budget: ArchiveBudget,
  options: ArchiveReadOptions = {},
): ArchiveEntry[] | null {
  const v2 = options.ruleset === "v2";
  const looksLikeTar = v2 ? isTarV2 : isTar;
  const extension = extensionOf(path);
  const lower = path.toLowerCase();
  if (zipExtensions.has(extension) || startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    if (documentMimeTypes[extension]) return null;
    return unzip(bytes, budget);
  }
  if (lower.endsWith(".tar.gz") || extension === "tgz" || extension === "gz" || startsWith(bytes, [0x1f, 0x8b])) {
    const remaining = archiveLimits.maxExpandedBytes - budget.bytes;
    const inner = gunzip(bytes, remaining);
    const innerName = lower.endsWith(".gz") ? path.slice(0, -3) : `${path}.tar`;
    if (innerName.toLowerCase().endsWith(".tar") || extension === "tgz" || looksLikeTar(inner)) {
      return untar(inner, budget, options);
    }
    if (v2 && unopenedArchiveFormat(inner)) throw new ArchiveError("archive format this check cannot open");
    claim(budget, inner.byteLength);
    return [{ path: innerName.split("/").at(-1) ?? "file", bytes: inner }];
  }
  if (extension === "tar" || looksLikeTar(bytes)) return untar(bytes, budget, options);
  if (v2 && unopenedArchiveFormat(bytes)) throw new ArchiveError("archive format this check cannot open");
  return null;
}
