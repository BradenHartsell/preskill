/**
 * Ruleset v2 is opt-in. Every test here pairs the default (v1, unchanged) with
 * v2, so a change that leaks v2 behavior into the default fails. All Skills
 * here are synthetic; the judge is stubbed and no test reaches the network.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { unopenedArchiveFormat } from "../src/archive.js";
import { fetchSkillFromUrl, namedSkillFiles } from "../src/fetch.js";
import { skillFilesForCheck } from "../src/file-review.js";
import { createHttpJudge, type JudgeOptions } from "../src/judge.js";
import {
  definitions,
  descriptionBoundary,
  questionsForRuleset,
  skillSafetyQuestions,
  skillSafetyQuestionsV2,
} from "../src/questions.js";
import { scanSkill } from "../src/scanner.js";
import { parseSkillFolder } from "../src/skill.js";
import { questionIds, type SkillInputFile, type SkillSafetyState } from "../src/types.js";
import {
  computeQuestionSetContentHash,
  questionSetContentHash,
  questionSetContentHashV2,
  questionSetVersion,
  questionSetVersionFor,
  questionSetVersionV2,
} from "../src/version.js";
import { answers, binaryFile, makeGzip, skillMd, stubJudge, textFile } from "./helpers.js";

const v2Snapshot = JSON.parse(
  readFileSync(new URL("./fixtures/port-fidelity-v2.snapshot.json", import.meta.url), "utf8"),
) as unknown;

const source = { link: "https://example.test/skill", catalog: "web", catalog_review: "suspicious" } as const;

/** A judge that records each state and the options it was called with. */
function recordingJudge(): {
  judge: Parameters<typeof scanSkill>[1]["judge"];
  calls: { state: SkillSafetyState; options: JudgeOptions | undefined }[];
} {
  const calls: { state: SkillSafetyState; options: JudgeOptions | undefined }[] = [];
  return {
    calls,
    judge: {
      model: "stub/model",
      provider: "custom",
      async judge(state, options) {
        calls.push({ state, options });
        return { model: "stub/model", answers: answers(0), usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 0 };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// questions
// ---------------------------------------------------------------------------

test("v2 questions match the checked-in v2 snapshot", () => {
  assert.deepEqual(skillSafetyQuestionsV2, v2Snapshot);
});

test("v1 stays the default and its hash and version are unchanged", async () => {
  assert.equal(await computeQuestionSetContentHash(), questionSetContentHash);
  assert.equal(questionSetContentHash, "38554836eb061d76");
  assert.equal(questionSetVersionFor(), questionSetVersion);
  assert.equal(questionsForRuleset(), skillSafetyQuestions);
  assert.equal(skillSafetyQuestions.deceives_the_person.instructions.definitions, definitions);
});

test("v2 has its own hash and version", async () => {
  assert.equal(await computeQuestionSetContentHash("v2"), questionSetContentHashV2);
  assert.notEqual(questionSetContentHashV2, questionSetContentHash);
  assert.equal(questionSetVersionV2, `skill-install-safety-v11-oss#${questionSetContentHashV2}`);
  assert.equal(questionSetVersionFor("v2"), questionSetVersionV2);
  assert.equal(questionsForRuleset("v2"), skillSafetyQuestionsV2);
});

test("v2 adds the description boundary after the present-threat boundary on every question", () => {
  for (const id of questionIds) {
    const v1 = skillSafetyQuestions[id].instructions.boundaries;
    const v2 = skillSafetyQuestionsV2[id].instructions.boundaries;
    assert.equal(v2[0], v1[0], id);
    assert.equal(v2[1], descriptionBoundary, id);
    assert.equal(v2.filter((boundary) => boundary === descriptionBoundary).length, 1, id);
  }
});

test("v2 never shows a catalog verdict: no catalog_review definition or boundary", () => {
  for (const id of questionIds) {
    const text = JSON.stringify(skillSafetyQuestionsV2[id]);
    assert.doesNotMatch(text, /catalog_review/u, id);
    assert.match(JSON.stringify(skillSafetyQuestions[id]), /catalog_review/u, id);
  }
});

test("v2 keeps every task, purpose, criterion and example of v1", () => {
  for (const id of questionIds) {
    const v1 = skillSafetyQuestions[id];
    const v2 = skillSafetyQuestionsV2[id];
    assert.deepEqual(v2.criteria, v1.criteria, id);
    assert.equal(v2.instructions.task, v1.instructions.task, id);
    assert.equal(v2.instructions.purpose, v1.instructions.purpose, id);
    assert.deepEqual(v2.instructions.context, v1.instructions.context, id);
    const removed = v1.instructions.boundaries.filter((boundary) => !v2.instructions.boundaries.includes(boundary));
    assert.equal(removed.length, 1, id);
    assert.match(removed[0] ?? "", /catalog_review/u, id);
  }
});

test("the v2 skill definition says the name and description are the hint for when to use it", () => {
  const skill = skillSafetyQuestionsV2.takes_person_data_elsewhere.instructions.definitions.skill ?? "";
  assert.match(skill, /The name and description are the hint the agent is shown for when to use the Skill/u);
  assert.match(descriptionBoundary, /persona/u);
  assert.match(descriptionBoundary, /password or card number/u);
});

test("v2 wording names only the agent and the platform", () => {
  const text = JSON.stringify(skillSafetyQuestionsV2);
  assert.doesNotMatch(text, /buddy|vxbe/iu);
  assert.match(descriptionBoundary, /coming from the platform or the system/u);
});

// ---------------------------------------------------------------------------
// scanner and judge
// ---------------------------------------------------------------------------

const plainSkill = [textFile("SKILL.md", skillMd("plain-skill", "Formats dates.", "Write dates as YYYY-MM-DD."))];

test("by default the judge gets the v1 state and no questions option", async () => {
  const { judge, calls } = recordingJudge();
  const result = await scanSkill({ files: plainSkill, source }, { judge });
  assert.equal(result.questionSetVersion, questionSetVersion);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.state.source.catalog_review, "suspicious");
  assert.equal(calls[0]?.options?.questions, undefined);
});

test("v2 hands the judge the v2 questions and strips the catalog verdict from the state", async () => {
  const { judge, calls } = recordingJudge();
  const result = await scanSkill({ files: plainSkill, source }, { judge, ruleset: "v2" });
  assert.equal(result.verdict, "safe");
  assert.equal(result.questionSetVersion, questionSetVersionV2);
  assert.equal(calls[0]?.options?.questions, skillSafetyQuestionsV2);
  assert.deepEqual(calls[0]?.state.source, { link: source.link, catalog: "web" });
  assert.equal(Object.hasOwn(calls[0]?.state.source ?? {}, "catalog_review"), false);
});

test("an unknown ruleset is an invalid configuration, never a silent default", async () => {
  const result = await scanSkill(
    { files: plainSkill, source },
    { judge: stubJudge([0]), ruleset: "v3" as unknown as "v2" },
  );
  assert.equal(result.verdict, "refused");
  assert.equal(result.refusals[0]?.code, "invalid configuration");
  assert.equal(result.requestCount, 0);
});

test("the HTTP judge sends v1 questions by default and the questions it is given", async () => {
  const bodies: { questions: unknown }[] = [];
  const fetcher = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body)) as { questions: unknown });
    return new Response(
      JSON.stringify({
        model: "mock-decider",
        answers: Object.fromEntries(questionIds.map((id) => [id, { type: "noul", noul: 0 }])),
        usage: { input_tokens: 1, output_tokens: 0 },
      }),
      { status: 200 },
    );
  };
  const judge = createHttpJudge({ apiKey: "test-key", provider: "perplexity", fetch: fetcher as typeof fetch });
  await scanSkill({ files: plainSkill, source }, { judge });
  await scanSkill({ files: plainSkill, source }, { judge, ruleset: "v2" });
  assert.deepEqual(bodies[0]?.questions, JSON.parse(JSON.stringify(skillSafetyQuestions)));
  assert.deepEqual(bodies[1]?.questions, JSON.parse(JSON.stringify(skillSafetyQuestionsV2)));
});

test("a question answer still flags under v2 exactly as under v1", async () => {
  for (const ruleset of [undefined, "v2"] as const) {
    const result = await scanSkill(
      { files: plainSkill, source },
      { judge: stubJudge([{ overrides_agent_safeguards: 0.9 }]), ...(ruleset ? { ruleset } : {}) },
    );
    assert.equal(result.verdict, "flagged");
    assert.deepEqual(result.flaggedQuestions, ["overrides_agent_safeguards"]);
  }
});

// ---------------------------------------------------------------------------
// archives
// ---------------------------------------------------------------------------

const sevenZip = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04, 0x01, 0x02, 0x03, 0x04];

async function review(files: SkillInputFile[], ruleset?: "v2") {
  const parsed = parseSkillFolder(files, { lenientName: true });
  return skillFilesForCheck(parsed.skill, parsed.files, undefined, ruleset ? { ruleset } : {});
}

test("a 7z archive the Skill never names is a data asset in v1 and refused in v2", async () => {
  const files = [textFile("SKILL.md", skillMd("seven-zip", "Ships a bundle.")), binaryFile("bundle.dat", sevenZip)];
  const v1 = await review(files);
  assert.deepEqual(v1.dataAssets, ["bundle.dat"]);
  assert.equal(v1.refusals.length, 0);
  const v2 = await review(files, "v2");
  assert.equal(v2.refusals[0]?.code, "archive format this check cannot open");
  assert.equal(v2.refusals[0]?.path, "bundle.dat");
});

test("in v2 a 7z named like a picture is still refused by its bytes", async () => {
  const files = [textFile("SKILL.md", skillMd("disguised", "Has a logo.")), binaryFile("assets/logo.png", sevenZip)];
  assert.deepEqual((await review(files)).dataAssets, ["assets/logo.png"]);
  assert.equal((await review(files, "v2")).refusals[0]?.code, "archive format this check cannot open");
});

test("in v2 a gzip around an unopened format is refused", async () => {
  const files = [
    textFile("SKILL.md", skillMd("gz-xz", "Ships data.")),
    binaryFile("data.gz", [...makeGzip(Uint8Array.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 1, 2]))]),
  ];
  assert.equal((await review(files, "v2")).refusals[0]?.code, "archive format this check cannot open");
});

test("bzip2 needs its block marker, so text starting BZh is not an archive", () => {
  assert.equal(unopenedArchiveFormat(new TextEncoder().encode("BZh9 is how a note might start")), false);
  assert.equal(
    unopenedArchiveFormat(Uint8Array.from([0x42, 0x5a, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59, 0])),
    true,
  );
});

/** One tar header block, ustar unless `magic` is false. */
function header(name: string, size: number, type: string, magic = true): Uint8Array {
  const block = new Uint8Array(512);
  const put = (text: string, at: number): void => block.set(new TextEncoder().encode(text), at);
  put(name.slice(0, 100), 0);
  put("0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124);
  put("00000000000\0", 136);
  put("        ", 148);
  put(type, 156);
  if (magic) {
    put("ustar\0", 257);
    put("00", 263);
  }
  let sum = 0;
  for (const byte of block) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

function padded(data: Uint8Array): Uint8Array[] {
  return [data, new Uint8Array((512 - (data.byteLength % 512)) % 512)];
}

function paxData(records: Record<string, string>): Uint8Array {
  let text = "";
  for (const [key, value] of Object.entries(records)) {
    const body = ` ${key}=${value}\n`;
    let length = body.length + 1;
    while (`${length}${body}`.length !== length) length = `${length}${body}`.length;
    text += `${length}${body}`;
  }
  return new TextEncoder().encode(text);
}

function tar(blocks: Uint8Array[]): Uint8Array {
  const all = [...blocks, new Uint8Array(1024)];
  const out = new Uint8Array(all.reduce((sum, block) => sum + block.byteLength, 0));
  let offset = 0;
  for (const block of all) {
    out.set(block, offset);
    offset += block.byteLength;
  }
  return out;
}

const script = new TextEncoder().encode("echo hello\n");

test("a pax header that renames an entry out of the Skill is followed in v2", async () => {
  const pax = paxData({ path: "../../outside.sh" });
  const archive = tar([header("PaxHeader", pax.byteLength, "x"), ...padded(pax), header("safe.sh", script.byteLength, "0"), ...padded(script)]);
  const files = [textFile("SKILL.md", skillMd("pax-rename", "Ships a bundle.", "Unpack bundle.tar.")), binaryFile("bundle.tar", [...archive])];
  const v1 = await review(files);
  assert.deepEqual(v1.files.map((file) => file.path), ["bundle.tar!/safe.sh"]);
  const v2 = await review(files, "v2");
  assert.equal(v2.refusals[0]?.code, "unsafe path");
  assert.equal(v2.files.length, 0);
});

test("a pax long name inside the Skill is judged under the name it unpacks to in v2", async () => {
  const longName = `docs/${"a".repeat(120)}.sh`;
  const pax = paxData({ path: longName });
  const archive = tar([header("PaxHeader", pax.byteLength, "x"), ...padded(pax), header("short.sh", script.byteLength, "0"), ...padded(script)]);
  const files = [textFile("SKILL.md", skillMd("pax-long", "Ships a bundle.", "Unpack bundle.tar.")), binaryFile("bundle.tar", [...archive])];
  const v2 = await review(files, "v2");
  assert.equal(v2.refusals.length, 0);
  assert.deepEqual(v2.files.map((file) => file.path), [`bundle.tar!/${longName}`]);
});

test("GNU sparse files and a renaming global header cannot be checked in v2", async () => {
  const sparse = tar([header("sparse.bin", 0, "S")]);
  const globalPax = paxData({ path: "renamed.sh" });
  const global = tar([header("GlobalHead", globalPax.byteLength, "g"), ...padded(globalPax), header("a.sh", script.byteLength, "0"), ...padded(script)]);
  for (const archive of [sparse, global]) {
    const files = [textFile("SKILL.md", skillMd("tar-feature", "Ships a bundle.", "Unpack bundle.tar.")), binaryFile("bundle.tar", [...archive])];
    assert.equal((await review(files)).refusals.length, 0);
    assert.equal((await review(files, "v2")).refusals[0]?.code, "archive feature that cannot be checked");
  }
});

test("a v7 tar with no ustar magic is unpacked in v2", async () => {
  const archive = tar([header("run.sh", script.byteLength, "0", false), ...padded(script)]);
  const files = [textFile("SKILL.md", skillMd("v7-tar", "Ships data.")), binaryFile("payload.dat", [...archive])];
  assert.deepEqual((await review(files)).dataAssets, ["payload.dat"]);
  const v2 = await review(files, "v2");
  assert.deepEqual(v2.files.map((file) => file.path), ["payload.dat!/run.sh"]);
});

test("a root ./ directory entry is not an unsafe path in v2", async () => {
  const archive = tar([header("./", 0, "5"), header("./run.sh", script.byteLength, "0"), ...padded(script)]);
  const files = [textFile("SKILL.md", skillMd("root-dir", "Ships a bundle.", "Unpack bundle.tar.")), binaryFile("bundle.tar", [...archive])];
  const v2 = await review(files, "v2");
  assert.equal(v2.refusals.length, 0);
  assert.deepEqual(v2.files.map((file) => file.path), ["bundle.tar!/run.sh"]);
});

// ---------------------------------------------------------------------------
// links: bare document names
// ---------------------------------------------------------------------------

const bareText = [
  "Fill the form with the steps in FORMS.md, and see REFERENCE.md for the API.",
  "",
  "```bash",
  "cat output.txt > notes.md",
  "```",
].join("\n");

test("bare document names outside fenced code are named only in v2", () => {
  assert.deepEqual(namedSkillFiles(bareText, ""), []);
  assert.deepEqual(namedSkillFiles(bareText, "", { ruleset: "v2" }), ["FORMS.md", "REFERENCE.md"]);
  assert.deepEqual(namedSkillFiles("See SKILL.md and package.json.", "", { ruleset: "v2" }), []);
});

function respond(text: string, status = 200): Response {
  return new Response(new TextEncoder().encode(text), { status });
}

test("a linked Skill's bare names are read in v2; one the host lacks flags instead of refusing", async () => {
  const manifest = skillMd("bare-names", "Fills forms.", bareText);
  const fetcher = async (url: string | URL | Request): Promise<Response> => {
    const address = String(url);
    if (address.endsWith("/SKILL.md")) return respond(manifest);
    if (address.endsWith("/FORMS.md")) return respond("Step one: open the form.");
    return respond("not here", 404);
  };
  const link = "https://example.test/skills/bare/SKILL.md";
  const v1 = await fetchSkillFromUrl(link, { fetch: fetcher as typeof fetch });
  assert.deepEqual(v1.files.map((file) => file.path), ["SKILL.md"]);
  assert.deepEqual(v1.missingFiles, []);

  const v2 = await fetchSkillFromUrl(link, { fetch: fetcher as typeof fetch, ruleset: "v2" });
  assert.deepEqual(v2.files.map((file) => file.path), ["FORMS.md", "SKILL.md"]);
  assert.deepEqual(v2.missingFiles, [{ path: "REFERENCE.md", reason: "not_found", bareName: true }]);

  const flagged = await scanSkill({ ...v2, missingFiles: v2.missingFiles }, { judge: stubJudge([0]), ruleset: "v2" });
  assert.equal(flagged.verdict, "flagged");
  assert.deepEqual(flagged.flaggedPaths, ["REFERENCE.md"]);
  assert.match(flagged.reasons.other[0] ?? "", /REFERENCE\.md is named in the Skill's text but was not found/u);
  assert.equal(flagged.refusals.length, 0);

  const refused = await scanSkill({ ...v2, missingFiles: v2.missingFiles }, { judge: stubJudge([0]) });
  assert.equal(refused.verdict, "refused");
  assert.equal(refused.refusals[0]?.code, "missing named file");
});

test("a file named by a link stays a hard refusal in v2 even if also named bare", async () => {
  const manifest = skillMd("linked-and-bare", "Uses a guide.", "Read [the guide](GUIDE.md). GUIDE.md has the steps.");
  const fetcher = async (url: string | URL | Request): Promise<Response> =>
    String(url).endsWith("/SKILL.md") ? respond(manifest) : respond("not here", 404);
  const fetched = await fetchSkillFromUrl("https://example.test/s/SKILL.md", { fetch: fetcher as typeof fetch, ruleset: "v2" });
  assert.deepEqual(fetched.missingFiles, [{ path: "GUIDE.md", reason: "not_found" }]);
  const result = await scanSkill(fetched, { judge: stubJudge([0]), ruleset: "v2" });
  assert.equal(result.verdict, "refused");
});
