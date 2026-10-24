import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSkillText, bytecodeStrings } from "../src/text.js";
import { skillEncodedCodeFiles, skillFilesForCheck } from "../src/file-review.js";
import type { ParsedSkill, SkillInputFile } from "../src/types.js";
import {
  binaryFile,
  makeGzip,
  makeTar,
  makeTarGzip,
  makeZip,
  textFile,
} from "./helpers.js";

const skill: ParsedSkill = { name: "test-skill", description: "A test", bodyMarkdown: "Body" };

function utf16le(text: string): Uint8Array {
  const output = new Uint8Array(2 + text.length * 2);
  output[0] = 0xff;
  output[1] = 0xfe;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    output[2 + index * 2] = code & 0xff;
    output[3 + index * 2] = code >> 8;
  }
  return output;
}

function utf16be(text: string): Uint8Array {
  const output = new Uint8Array(2 + text.length * 2);
  output[0] = 0xfe;
  output[1] = 0xff;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    output[2 + index * 2] = code >> 8;
    output[3 + index * 2] = code & 0xff;
  }
  return output;
}

test("text decoding follows the encodings files actually use", () => {
  assert.equal(decodeSkillText(new TextEncoder().encode("hello")), "hello");
  assert.equal(decodeSkillText(Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("hello")])), "hello");
  assert.equal(decodeSkillText(utf16le("hello")), "hello");
  assert.equal(decodeSkillText(utf16be("hello")), "hello");
  assert.equal(decodeSkillText(new TextEncoder().encode("caf\u00e9")), "caf\u00e9");
  assert.equal(decodeSkillText(Uint8Array.from([0x63, 0x61, 0x66, 0xe9])), "caf\u00e9");
  assert.equal(decodeSkillText(Uint8Array.from([0x00, 0x01, 0x02, 0x00])), null);
  assert.equal(decodeSkillText(Uint8Array.from([0x00])), null);
});

test("bytecode strings are the printable runs of four or more characters", () => {
  const bytes = Uint8Array.from([0x00, 0x7f, ...new TextEncoder().encode("exec"), 0x00, ...new TextEncoder().encode("run_payload")]);
  assert.equal(bytecodeStrings(bytes), "exec\nrun_payload");
});

test("plain text is read as text", async () => {
  const files: SkillInputFile[] = [textFile("references/notes.md", "hello")];
  const result = await skillFilesForCheck(skill, files);
  assert.equal(result.refusals.length, 0);
  assert.equal(result.files[0]?.path, "references/notes.md");
  assert.equal(result.files[0]?.readAs, "text");
});

test("a compiled native program is refused by extension and by magic", async () => {
  const byExtension = await skillFilesForCheck(skill, [binaryFile("scripts/tool.exe", [0x00, 0x01])]);
  assert.equal(byExtension.refusals[0]?.code, "compiled native program");
  const byMagic = await skillFilesForCheck(skill, [binaryFile("data/payload.dat", [0x4d, 0x5a, 0x90, 0x00])]);
  assert.equal(byMagic.refusals[0]?.code, "compiled native program");
});

test("bytecode is judged by the strings it carries", async () => {
  const bytes = Uint8Array.from([0x00, ...new TextEncoder().encode("subprocess"), 0x00]);
  const result = await skillFilesForCheck(skill, [{ path: "scripts/run.pyc", bytes }]);
  assert.equal(result.files[0]?.readAs, "bytecode strings");
  assert.equal(result.files[0]?.text, "subprocess");
});

test("a zip is unpacked and its entries judged as archive entry text", async () => {
  const zip = makeZip([{ path: "scripts/run.py", data: new TextEncoder().encode("print('hello')") }], 8);
  const result = await skillFilesForCheck(skill, [{ path: "bundle.zip", bytes: zip }]);
  assert.equal(result.refusals.length, 0);
  assert.equal(result.files[0]?.path, "bundle.zip!/scripts/run.py");
  assert.equal(result.files[0]?.readAs, "archive entry text");
  assert.equal(result.files[0]?.text, "print('hello')");
});

test("tar and tar.gz resources are unpacked", async () => {
  const data = [{ path: "references/a.md", data: new TextEncoder().encode("alpha") }];
  const tarResult = await skillFilesForCheck(skill, [{ path: "bundle.tar", bytes: makeTar(data) }]);
  assert.equal(tarResult.files[0]?.text, "alpha");
  const gzResult = await skillFilesForCheck(skill, [{ path: "bundle.tar.gz", bytes: makeTarGzip(data) }]);
  assert.equal(gzResult.files[0]?.text, "alpha");
  const single = await skillFilesForCheck(skill, [{ path: "notes.txt.gz", bytes: makeGzip(new TextEncoder().encode("hello")) }]);
  assert.equal(single.files[0]?.path, "notes.txt.gz!/notes.txt");
  assert.equal(single.files[0]?.text, "hello");
});

test("a corrupted ZIP entry is refused, not read as altered text", async () => {
  const zip = makeZip([{ path: "a.txt", data: new TextEncoder().encode("hello") }]);
  const corrupted = zip.slice();
  const dataIndex = 30 + "a.txt".length;
  corrupted[dataIndex] = (corrupted[dataIndex] ?? 0) ^ 0xff;
  const result = await skillFilesForCheck(skill, [{ path: "bundle.zip", bytes: corrupted }]);
  assert.equal(result.files.length, 0);
  assert.equal(result.refusals[0]?.code, "damaged or password-protected");
});

test("a tar with a bad header checksum is refused", async () => {
  const tar = makeTar([{ path: "references/a.md", data: new TextEncoder().encode("alpha") }]);
  const corrupted = tar.slice();
  corrupted[148] = (corrupted[148] ?? 0) ^ 0x01;
  const result = await skillFilesForCheck(skill, [{ path: "bundle.tar", bytes: corrupted }]);
  assert.equal(result.files.length, 0);
  assert.equal(result.refusals[0]?.code, "damaged or password-protected");
});

test("a damaged or encrypted archive is refused", async () => {
  const damaged = await skillFilesForCheck(skill, [{ path: "bundle.zip", bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00]) }]);
  assert.equal(damaged.refusals[0]?.code, "damaged or password-protected");
  const encrypted = makeZip([{ path: "a.txt", data: new TextEncoder().encode("a"), encrypted: true }]);
  const encryptedResult = await skillFilesForCheck(skill, [{ path: "bundle.zip", bytes: encrypted }]);
  assert.equal(encryptedResult.refusals[0]?.code, "damaged or password-protected");
});

test("the expanded-size limit refuses an oversized archive", async () => {
  const zip = makeZip([
    {
      path: "references/huge.txt",
      data: new Uint8Array([65]),
      declaredUncompressedSize: 16 * 1024 * 1024 + 1,
    },
  ]);
  const result = await skillFilesForCheck(skill, [{ path: "bundle.zip", bytes: zip }]);
  assert.ok(result.refusals.some((entry) => entry.code === "archive too large or too deep"));
});

test("an archive path that climbs out is refused", async () => {
  const zip = makeZip([{ path: "../evil.txt", data: new TextEncoder().encode("x") }]);
  const result = await skillFilesForCheck(skill, [{ path: "bundle.zip", bytes: zip }]);
  assert.equal(result.refusals[0]?.code, "unsafe path");
});

test("the entry count limit refuses a zip bomb before it is unpacked", async () => {
  const entries = Array.from({ length: 257 }, (_, index) => ({
    path: `references/${String(index)}.txt`,
    data: new Uint8Array([65]),
  }));
  const result = await skillFilesForCheck(skill, [{ path: "bundle.zip", bytes: makeZip(entries) }]);
  assert.ok(result.refusals.some((entry) => entry.code === "archive too large or too deep"));
});

test("nested archives stop at the depth limit", async () => {
  const inner = makeZip([{ path: "a.txt", data: new TextEncoder().encode("a") }]);
  const level3 = makeZip([{ path: "inner.zip", data: inner }]);
  const level2 = makeZip([{ path: "level3.zip", data: level3 }]);
  const level1 = makeZip([{ path: "level2.zip", data: level2 }]);
  const result = await skillFilesForCheck(skill, [{ path: "level1.zip", bytes: level1 }]);
  assert.ok(result.refusals.some((entry) => entry.code === "archive too large or too deep"));
});

test("an unknown binary is refused only when the Skill uses it", async () => {
  const bytes = Uint8Array.from([0x00, 0x01, 0x02, 0x03]);
  const unnamed = await skillFilesForCheck(skill, [{ path: "assets/blob.dat", bytes }]);
  assert.equal(unnamed.refusals.length, 0);
  assert.deepEqual(unnamed.dataAssets, ["assets/blob.dat"]);

  const namedSkill: ParsedSkill = { ...skill, bodyMarkdown: "Use assets/blob.dat now." };
  const named = await skillFilesForCheck(namedSkill, [{ path: "assets/blob.dat", bytes }]);
  assert.equal(named.refusals[0]?.code, "unknown binary format");
});

test("a named image with no visual reader is refused; an unnamed one is a data asset", async () => {
  const png = binaryFile("assets/logo.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const unnamed = await skillFilesForCheck(skill, [png]);
  assert.deepEqual(unnamed.dataAssets, ["assets/logo.png"]);
  const namedSkill: ParsedSkill = { ...skill, bodyMarkdown: "Show assets/logo.png." };
  const named = await skillFilesForCheck(namedSkill, [png]);
  assert.equal(named.refusals[0]?.code, "unreadable file type");
});

test("an optional visual reader reads a named image", async () => {
  const png = binaryFile("assets/logo.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const namedSkill: ParsedSkill = { ...skill, bodyMarkdown: "Show assets/logo.png." };
  const result = await skillFilesForCheck(namedSkill, [png], {
    async describeVisual() {
      return "A blue logo";
    },
  });
  assert.equal(result.files[0]?.readAs, "visual reading");
  assert.equal(result.files[0]?.text, "A blue logo");
});

test("a ZIP-based office document is read without a model", async () => {
  const docx = makeZip([
    {
      path: "word/document.xml",
      data: new TextEncoder().encode("<w:document><w:body><w:p><w:r><w:t>Hello report</w:t></w:r></w:p></w:body></w:document>"),
    },
  ]);
  const result = await skillFilesForCheck(skill, [{ path: "references/report.docx", bytes: docx }]);
  assert.equal(result.files[0]?.readAs, "document text");
  assert.match(result.files[0]?.text ?? "", /Hello report/u);
});

test("encoded code needs both a decoder and an execution sink", () => {
  const base64Asset = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  assert.deepEqual(skillEncodedCodeFiles([{ path: "assets/logo.txt", text: `data:image/png;base64,${base64Asset}` }]), []);
  assert.deepEqual(skillEncodedCodeFiles([{ path: "scripts/a.py", text: "payload = base64.b64decode('aGVsbG8=')" }]), []);
  assert.deepEqual(skillEncodedCodeFiles([{ path: "scripts/a.sh", text: "base64 -d file" }]), []);

  const cases = [
    'exec(base64.b64decode("cHJpbnQoMSk="))',
    "echo aGVsbG8= | base64 -d | sh",
    'eval "$(echo aGVsbG8= | base64 -d)"',
    "bash <(base64 -d payload)",
    "powershell -EncodedCommand ZQBjAGgAbwAgAGgAaQ==",
    'payload = base64.b64decode("cHJpbnQoMSk=")\nexec(payload)',
    'const x = Buffer.from("aGVsbG8=", "base64").toString(); eval(x)',
  ];
  for (const text of cases) {
    assert.deepEqual(skillEncodedCodeFiles([{ path: "scripts/run.txt", text }]), ["scripts/run.txt"], text);
  }
});
