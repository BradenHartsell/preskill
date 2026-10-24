import { gzipSync, deflateRawSync } from "node:zlib";
import type { Judge, JudgeResult } from "../src/judge.js";
import type { QuestionId, SkillInputFile, SkillSafetyState } from "../src/types.js";

export function textFile(path: string, text: string): SkillInputFile {
  return { path, bytes: new TextEncoder().encode(text) };
}

export function binaryFile(path: string, bytes: readonly number[]): SkillInputFile {
  return { path, bytes: Uint8Array.from(bytes) };
}

export function skillMd(name: string, description: string, body = "Do the thing."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

export function answers(value: number | Partial<Record<QuestionId, number>>): Readonly<Record<QuestionId, number>> {
  const ids: QuestionId[] = [
    "takes_person_data_elsewhere",
    "deceives_the_person",
    "hides_actions_from_the_person",
    "harms_other_people",
    "collects_person_secrets",
    "runs_harmful_software",
    "overrides_agent_safeguards",
  ];
  const all = Object.fromEntries(ids.map((id) => [id, 0])) as Record<QuestionId, number>;
  if (typeof value === "number") for (const id of ids) all[id] = value;
  else Object.assign(all, value);
  return all;
}

export function stubJudge(
  values: readonly (number | Partial<Record<QuestionId, number>>)[] | ((state: SkillSafetyState, call: number) => number | Partial<Record<QuestionId, number>>),
): Judge {
  let call = 0;
  return {
    model: "stub/model",
    provider: "custom",
    async judge(state): Promise<JudgeResult> {
      const index = call;
      call += 1;
      const value = typeof values === "function" ? values(state, index) : (values[index] ?? 0);
      return {
        model: "stub/model",
        answers: answers(value),
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        latencyMs: 0,
      };
    },
  };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  path: string;
  data: Uint8Array;
  method?: 0 | 8;
  encrypted?: boolean;
  symlink?: boolean;
  declaredUncompressedSize?: number;
}

export function makeZip(entries: readonly ZipEntry[], defaultMethod: 0 | 8 = 0): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.path);
    const method = entry.method ?? defaultMethod;
    const compressed = method === 8 ? new Uint8Array(deflateRawSync(entry.data)) : entry.data;
    const crc = crc32(entry.data);
    const uncompressedSize = entry.declaredUncompressedSize ?? entry.data.byteLength;
    const flags = entry.encrypted ? 1 : 0;
    const local = new Uint8Array(30 + name.byteLength);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, flags, true);
    view.setUint16(8, method, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, compressed.byteLength, true);
    view.setUint32(22, uncompressedSize, true);
    view.setUint16(26, name.byteLength, true);
    view.setUint16(28, 0, true);
    local.set(name, 30);
    locals.push(local, compressed);
    chunks.push(local, compressed);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, method, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, compressed.byteLength, true);
    centralView.setUint32(24, uncompressedSize, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, entry.symlink ? (0o120777 << 16) >>> 0 : 0, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.byteLength + compressed.byteLength;
  }
  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, part) => sum + entryLength(centrals, part), 0);
  void centralSize;
  const centralBytes = concat(centrals);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralBytes.byteLength, true);
  eocdView.setUint32(16, centralOffset, true);
  eocdView.setUint16(20, 0, true);
  return concat([...chunks, centralBytes, eocd]);
}

function entryLength(parts: readonly Uint8Array[], target: Uint8Array): number {
  void parts;
  return target.byteLength;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function makeGzip(data: Uint8Array): Uint8Array {
  return new Uint8Array(gzipSync(data));
}

function tarHeader(path: string, size: number, type = "0"): Uint8Array {
  const header = new Uint8Array(512);
  const name = new TextEncoder().encode(path);
  header.set(name.subarray(0, 100), 0);
  header.set(new TextEncoder().encode("0000644\0"), 100);
  header.set(new TextEncoder().encode("0000000\0"), 108);
  header.set(new TextEncoder().encode("0000000\0"), 116);
  header.set(new TextEncoder().encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
  header.set(new TextEncoder().encode("00000000000\0"), 136);
  header.set(new TextEncoder().encode("        "), 148);
  header.set(new TextEncoder().encode(type), 156);
  header.set(new TextEncoder().encode("ustar\0"), 257);
  header.set(new TextEncoder().encode("00"), 263);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.set(new TextEncoder().encode(`${checksum.toString(8).padStart(6, "0")}\0 `), 148);
  return header;
}

export function makeTar(entries: readonly { path: string; data: Uint8Array; symlink?: boolean }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry.path, entry.data.byteLength, entry.symlink ? "2" : "0"));
    chunks.push(entry.data);
    const padding = (512 - (entry.data.byteLength % 512)) % 512;
    chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  return concat(chunks);
}

export function makeTarGzip(entries: readonly { path: string; data: Uint8Array }[]): Uint8Array {
  return makeGzip(makeTar(entries));
}
