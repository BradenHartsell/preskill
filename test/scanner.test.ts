import assert from "node:assert/strict";
import { test } from "node:test";
import { JudgeError, type Judge } from "../src/judge.js";
import { scanSkill } from "../src/scanner.js";
import type { SkillInputFile, SkillSafetyState } from "../src/types.js";
import { answers, binaryFile, skillMd, stubJudge, textFile } from "./helpers.js";

const source = { link: "https://example.test/skill", catalog: "web", catalog_review: "not_checked" } as const;

function input(files: readonly SkillInputFile[]) {
  return { files, source };
}

function throwingJudge(counter: { calls: number }): Judge {
  return {
    model: "stub/model",
    provider: "custom",
    async judge() {
      counter.calls += 1;
      throw new Error("the judge must not be called");
    },
  };
}

test("a clean Skill is safe and one request is made", async () => {
  const result = await scanSkill(
    { files: [textFile("SKILL.md", skillMd("safe-skill", "A safe skill"))], source },
    { judge: stubJudge([0]) },
  );
  assert.equal(result.verdict, "safe");
  assert.equal(result.requestCount, 1);
  assert.deepEqual(result.flaggedQuestions, []);
  assert.equal(result.questionSetVersion.startsWith("skill-install-safety-v9-oss#"), true);
});

test("a question at the floor flags, and one below it does not", async () => {
  const files = [textFile("SKILL.md", skillMd("floor-skill", "A skill"))];
  const at = await scanSkill({ files, source }, { judge: stubJudge([{ takes_person_data_elsewhere: 0.05 }]) });
  assert.equal(at.verdict, "flagged");
  assert.deepEqual(at.flaggedQuestions, ["takes_person_data_elsewhere"]);
  assert.equal(at.reasons.questions.takes_person_data_elsewhere, "It would send the person's private information somewhere they didn't choose.");

  const below = await scanSkill({ files, source }, { judge: stubJudge([{ takes_person_data_elsewhere: 0.049 }]) });
  assert.equal(below.verdict, "safe");

  const raised = await scanSkill(
    { files, source },
    { judge: stubJudge([{ takes_person_data_elsewhere: 0.15 }]), floor: 0.2 },
  );
  assert.equal(raised.verdict, "safe");
});

test("each question takes its largest answer across requests and names the request's files", async () => {
  const bodyFile = `body-${"x".repeat(80_000)}`;
  const script = `EVIL_MARKER\n${"y".repeat(80_000)}`;
  const files = [textFile("SKILL.md", skillMd("split-evil", "A split skill", bodyFile)), textFile("scripts/run.py", script)];
  const judge: Judge = {
    model: "stub/model",
    provider: "custom",
    async judge(state: SkillSafetyState) {
      const carriesScript = state.documents.some((document) => document.text.includes("EVIL_MARKER"));
      return {
        model: "stub/model",
        answers: answers(carriesScript ? { runs_harmful_software: 0.4, takes_person_data_elsewhere: 0.1 } : { runs_harmful_software: 0.2 }),
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        latencyMs: 0,
      };
    },
  };
  const result = await scanSkill({ files, source }, { judge, floor: 0.05 });
  assert.equal(result.verdict, "flagged");
  assert.ok(result.requestCount > 1);
  assert.equal(result.questionProbabilities.runs_harmful_software, 0.4);
  assert.equal(result.questionProbabilities.takes_person_data_elsewhere, 0.1);
  assert.ok(result.pathsByQuestion.runs_harmful_software?.includes("scripts/run.py"));
  assert.ok(result.pathsByQuestion.runs_harmful_software?.includes("SKILL.md"));
  assert.ok(result.pathsByQuestion.takes_person_data_elsewhere?.includes("SKILL.md"));
});

test("a credential-shaped value flags the Skill without refusing it", async () => {
  const body = "Use this:\nDB_PASSWORD=8f3kQ9zT1\n";
  const result = await scanSkill(
    { files: [textFile("SKILL.md", skillMd("secret-skill", "A skill", body))], source },
    { judge: stubJudge([0]) },
  );
  assert.equal(result.verdict, "flagged");
  assert.deepEqual(result.flaggedQuestions, []);
  assert.deepEqual(result.flaggedPaths, ["SKILL.md"]);
  assert.equal(result.credentialFindings?.[0]?.file, "SKILL.md");
  assert.deepEqual(result.credentialFindings?.[0]?.lines, [6]);
  assert.equal(result.reasons.other.some((sentence) => sentence.includes("line 6")), true);
  assert.equal(result.reasons.other.some((sentence) => sentence.includes("8f3kQ9zT1")), false);
});

test("credential line numbers include the real frontmatter lines", async () => {
  const manifest = "---\nname: line-skill\ndescription: A skill\nlicense: MIT\n---\nfirst\nDB_PASSWORD=8f3kQ9zT1\n";
  const result = await scanSkill(
    { files: [textFile("SKILL.md", manifest)], source },
    { judge: stubJudge([0]) },
  );
  assert.equal(result.verdict, "flagged");
  assert.deepEqual(result.credentialFindings?.[0]?.lines, [7]);
  assert.equal(result.reasons.other.some((sentence) => sentence.includes("line 7")), true);
});

test("a base64 data asset is not encoded code, but a decoder plus exec is refused", async () => {
  const asset = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const safe = await scanSkill(
    {
      files: [
        textFile("SKILL.md", skillMd("asset-skill", "A skill")),
        textFile("assets/logo.txt", `data:image/png;base64,${asset}`),
      ],
      source,
    },
    { judge: stubJudge([0]) },
  );
  assert.equal(safe.verdict, "safe");

  const counter = { calls: 0 };
  const refused = await scanSkill(
    {
      files: [textFile("SKILL.md", skillMd("encoded-skill", "A skill", 'exec(base64.b64decode("cHJpbnQoMSk="))'))],
      source,
    },
    { judge: throwingJudge(counter) },
  );
  assert.equal(refused.verdict, "refused");
  assert.equal(counter.calls, 0);
  assert.equal(refused.requestCount, 0);
  assert.equal(refused.refusals[0]?.code, "encoded code");
});

test("an unreadable file the Skill uses is a hard refusal", async () => {
  const counter = { calls: 0 };
  const result = await scanSkill(
    {
      files: [textFile("SKILL.md", skillMd("unreadable-skill", "A skill", "Run scripts/tool.exe")), binaryFile("scripts/tool.exe", [0x4d, 0x5a, 0x00])],
      source,
    },
    { judge: throwingJudge(counter) },
  );
  assert.equal(result.verdict, "refused");
  assert.equal(counter.calls, 0);
  assert.equal(result.refusals[0]?.code, "compiled native program");
});

test("a named file that could not be fetched refuses with a plain reason", async () => {
  const result = await scanSkill(
    {
      files: [textFile("SKILL.md", skillMd("missing-skill", "A skill"))],
      source,
      missingFiles: [{ path: "scripts/run.py", reason: "not_found" }],
    },
    { judge: throwingJudge({ calls: 0 }) },
  );
  assert.equal(result.verdict, "refused");
  assert.equal(result.refusals[0]?.code, "missing named file");
  assert.match(result.refusals[0]?.reason ?? "", /named by the Skill/u);
});

test("a named file over the size budget refuses with a plain reason", async () => {
  const result = await scanSkill(
    {
      files: [textFile("SKILL.md", skillMd("big-skill", "A skill"))],
      source,
      missingFiles: [{ path: "scripts/big.py", reason: "too_large" }],
    },
    { judge: throwingJudge({ calls: 0 }) },
  );
  assert.equal(result.verdict, "refused");
  assert.equal(result.refusals[0]?.code, "missing named file");
  assert.match(result.refusals[0]?.reason ?? "", /larger than the size limit/u);
});

test("a judge failure fails closed", async () => {
  const judge: Judge = {
    model: "stub/model",
    provider: "custom",
    async judge() {
      throw new JudgeError("timeout");
    },
  };
  const result = await scanSkill({ files: [textFile("SKILL.md", skillMd("timeout-skill", "A skill"))], source }, { judge });
  assert.equal(result.verdict, "refused");
  assert.equal(result.refusals[0]?.code, "judge unavailable");
});

test("a custom judge answer that is not a probability fails closed", async () => {
  const judge: Judge = {
    model: "stub/model",
    provider: "custom",
    async judge() {
      return {
        model: "stub/model",
        answers: { ...answers(0), runs_harmful_software: Number.NaN },
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        latencyMs: 0,
      };
    },
  };
  const result = await scanSkill({ files: [textFile("SKILL.md", skillMd("bad-answer", "A skill"))], source }, { judge });
  assert.equal(result.verdict, "refused");
  assert.equal(result.refusals[0]?.code, "judge unavailable");
});

test("a reader failure is a typed refusal, not an exception", async () => {
  const counter = { calls: 0 };
  const result = await scanSkill(
    {
      files: [
        textFile("SKILL.md", skillMd("reader-skill", "A skill", "Show assets/logo.png")),
        binaryFile("assets/logo.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      ],
      source,
    },
    {
      judge: throwingJudge(counter),
      reader: {
        async describeVisual() {
          throw new Error("reader outage");
        },
      },
    },
  );
  assert.equal(counter.calls, 0);
  assert.equal(result.verdict, "refused");
  assert.equal(result.refusals[0]?.code, "reader unavailable");
});

test("invalid numeric options are typed refusals, not crashes", async () => {
  const files = [textFile("SKILL.md", skillMd("option-skill", "A skill"))];
  for (const [label, options] of [
    ["concurrency", { concurrency: Number.NaN }],
    ["timeout", { timeoutMs: 0 }],
    ["floor", { floor: Number.NaN }],
  ] as const) {
    const result = await scanSkill({ files, source }, { judge: stubJudge([0]), ...options });
    assert.equal(result.verdict, "refused", label);
    assert.equal(result.refusals[0]?.code, "invalid configuration", label);
  }
});

test("an invalid manifest is refused, not guessed at", async () => {
  const result = await scanSkill(
    { files: [textFile("SKILL.md", "# no frontmatter\n")], source },
    { judge: throwingJudge({ calls: 0 }) },
  );
  assert.equal(result.verdict, "refused");
  assert.equal(result.refusals[0]?.code, "invalid skill");
});
