import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSkillFolder } from "../src/skill.js";
import {
  boundedPersonRequest,
  instructionsCharacters,
  requestTextCharacters,
  skillSafetyStates,
} from "../src/split.js";
import type { SkillFilesForCheck } from "../src/types.js";
import { skillMd, textFile } from "./helpers.js";

const source = { link: "https://example.test/skill", catalog: "web", catalog_review: "not_checked" } as const;

function longText(length: number, marker: string): string {
  const filler = `${marker} `.repeat(Math.ceil(length / (marker.length + 1)));
  return filler.slice(0, length);
}

test("a short Skill gets one request and keeps SKILL.md in instructions", () => {
  const files = [textFile("SKILL.md", skillMd("short-skill", "A short skill")), textFile("references/notes.md", "hello")];
  const { skill } = parseSkillFolder(files);
  const checked: SkillFilesForCheck = {
    files: [{ path: "references/notes.md", role: "reference", readAs: "text", text: "hello" }],
    dataAssets: [],
    refusals: [],
  };
  const states = skillSafetyStates({ skill, personRequest: "add it", source, files: checked });
  assert.equal(states.length, 1);
  assert.equal(states[0]?.skill.instructions, skill.bodyMarkdown);
  assert.equal(states[0]?.documents.length, 1);
  assert.equal(states[0]?.documents[0]?.part_count, 1);
  assert.equal(states[0]?.person_request, "add it");
  assert.deepEqual(states[0]?.source, source);
});

test("a single-file Skill still gets a request with an empty documents list", () => {
  const files = [textFile("SKILL.md", skillMd("one-file", "Only instructions"))];
  const { skill } = parseSkillFolder(files);
  const states = skillSafetyStates({
    skill,
    personRequest: "add it",
    source,
    files: { files: [], dataAssets: [], refusals: [] },
  });
  assert.equal(states.length, 1);
  assert.deepEqual(states[0]?.documents, []);
  assert.equal(states[0]?.skill.instructions, skill.bodyMarkdown);
});

test("a long SKILL.md is carried whole in numbered parts and its head is in instructions", () => {
  const body = longText(requestTextCharacters + 500, "instruction");
  const files = [textFile("SKILL.md", skillMd("long-skill", "Long instructions", body))];
  const { skill } = parseSkillFolder(files);
  const states = skillSafetyStates({
    skill,
    personRequest: "add it",
    source,
    files: { files: [], dataAssets: [], refusals: [] },
  });
  assert.ok(states.length >= 1);
  const parts = states.flatMap((state) => state.documents).filter((doc) => doc.path === "SKILL.md");
  assert.ok(parts.some((part) => part.part_count > 1));
  assert.equal(parts.map((part) => part.text).join(""), skill.bodyMarkdown);
  assert.equal(states[0]?.skill.instructions, skill.bodyMarkdown.slice(0, instructionsCharacters));
  for (const state of states) {
    assert.equal(state.files.find((entry) => entry.path === "SKILL.md")?.role, "instructions");
  }
});

test("every request carries the full manifest and the file text is never truncated", () => {
  const body = longText(requestTextCharacters + 20_000, "body");
  const script = longText(requestTextCharacters + 10, "script");
  const files = [textFile("SKILL.md", skillMd("split-skill", "Many files", body)), textFile("scripts/run.py", script)];
  const { skill } = parseSkillFolder(files);
  const checked: SkillFilesForCheck = {
    files: [{ path: "scripts/run.py", role: "script", readAs: "text", text: script }],
    dataAssets: ["assets/logo.png"],
    refusals: [],
  };
  const states = skillSafetyStates({ skill, personRequest: "add it", source, files: checked });
  assert.ok(states.length > 1);
  for (const state of states) {
    assert.deepEqual(
      state.files.map((entry) => entry.path),
      ["SKILL.md", "scripts/run.py", "assets/logo.png"],
    );
    assert.equal(state.files.at(-1)?.role, "data asset");
  }
  const scriptParts = states.flatMap((state) => state.documents).filter((doc) => doc.path === "scripts/run.py");
  assert.equal(scriptParts.map((part) => part.text).join(""), script);
  assert.equal(scriptParts[0]?.part_count, 2);
  const all = states.flatMap((state) => state.documents);
  assert.ok(all.every((doc) => doc.part_number >= 1 && doc.part_number <= doc.part_count));
});

test("the person request keeps its head and tail and is bounded in code", () => {
  const long = `${"a".repeat(5_000)}${"z".repeat(5_000)}`;
  const bounded = boundedPersonRequest(long);
  assert.ok(bounded.length < long.length);
  assert.ok(bounded.startsWith("a"));
  assert.ok(bounded.endsWith("z"));
  assert.ok(bounded.includes("[...]"));
});
