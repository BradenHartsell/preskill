import assert from "node:assert/strict";
import { test } from "node:test";
import { computeQuestionSetContentHash, defaultRefuseFloor, questionSetContentHash, questionSetVersion } from "../src/version.js";
import { questionIds } from "../src/types.js";
import { skillSafetyQuestions, questionReasons } from "../src/questions.js";
import { createStaticJudge, defaultModels } from "../src/judge.js";
import { scanSkill } from "../src/scanner.js";
import { answers, skillMd, textFile } from "./helpers.js";

test("the question set has seven questions, each with a reason", () => {
  assert.equal(Object.keys(skillSafetyQuestions).length, 7);
  assert.deepEqual(Object.keys(skillSafetyQuestions), [...questionIds]);
  for (const id of questionIds) assert.ok(questionReasons[id]?.length > 0);
});

test("the measured question set is unchanged", async () => {
  assert.equal(defaultRefuseFloor, 0.05);
  assert.equal(await computeQuestionSetContentHash(), questionSetContentHash);
  assert.equal(questionSetVersion, `skill-install-safety-v9-oss#${questionSetContentHash}`);
});

test("the question set carries the ported wording", () => {
  const task = skillSafetyQuestions.takes_person_data_elsewhere.instructions.task;
  assert.match(task, /make the agent send the person's private information/u);
  const override = skillSafetyQuestions.overrides_agent_safeguards;
  assert.match(override.criteria.true.examples[1] ?? "", /platform administrators/u);
  assert.match(override.instructions.boundaries.join(" "), /metric units/u);
});

test("a stub judge makes no network call and reports the configured model when no request is sent", async () => {
  const judge = createStaticJudge("custom/model", () => {
    throw new Error("not called");
  });
  const result = await scanSkill(
    { files: [textFile("SKILL.md", "# no frontmatter\n")], source: { link: "x", catalog: "web", catalog_review: "not_checked" } },
    { judge },
  );
  assert.equal(result.model, "custom/model");
  assert.equal(result.requestCount, 0);
  assert.equal(defaultModels.perplexity, "pplx-decider-v1.2");
  assert.equal(defaultModels.openrouter, "perplexity/pplx-decider-v1.2");
});

test("a skill is read without executing anything", async () => {
  const result = await scanSkill(
    {
      files: [textFile("SKILL.md", skillMd("no-exec", "A skill", "This text is only read."))],
      source: { link: "x", catalog: "web", catalog_review: "not_checked" },
    },
    {
      judge: createStaticJudge("custom/model", () => ({
        model: "custom/model",
        answers: answers(0),
        usage: { inputTokens: 10, outputTokens: 7 },
        latencyMs: 1,
      })),
    },
  );
  assert.equal(result.verdict, "safe");
});
