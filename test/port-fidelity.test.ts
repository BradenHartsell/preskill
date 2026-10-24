import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { skillSafetyQuestions } from "../src/questions.js";

const snapshot = JSON.parse(
  readFileSync(new URL("./fixtures/port-fidelity.snapshot.json", import.meta.url), "utf8"),
) as unknown;

test("the seven question objects match the checked-in port fidelity snapshot", () => {
  assert.deepEqual(skillSafetyQuestions, snapshot);
});

test("the snapshot keeps the source pronouns", () => {
  assert.match(
    skillSafetyQuestions.deceives_the_person.instructions.purpose,
    /it would have him mislead them/u,
  );
  assert.match(
    skillSafetyQuestions.hides_actions_from_the_person.instructions.task,
    /knowing what he did/u,
  );
  assert.match(
    skillSafetyQuestions.overrides_agent_safeguards.instructions.task,
    /drop his own rules.*telling him to ignore/u,
  );
  assert.match(
    skillSafetyQuestions.overrides_agent_safeguards.criteria.true.what,
    /switch off his rules/u,
  );
});
