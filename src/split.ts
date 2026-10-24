/**
 * How a Skill is split for the judge. SKILL.md and a manifest of every file
 * ride in every request; the remaining text is packed into requests of at most
 * `requestTextCharacters`, with a long file split into numbered parts. Nothing
 * is dropped or cut. Each request asks all seven questions together.
 */

import type { ParsedSkill } from "./types.js";
import type {
  QuestionId,
  SkillDocument,
  SkillFileRole,
  SkillFilesForCheck,
  SkillManifestEntry,
  SkillSafetyState,
  SkillSource,
} from "./types.js";

/** How much of the Skill's file text one request carries. */
export const requestTextCharacters = 80_000;

/** SKILL.md's head rides in every request; a longer one also goes whole into documents. */
export const instructionsCharacters = 30_000;

/** The person's message keeps its head and tail, bounded in code. */
export const personRequestHeadCharacters = 1_000;
export const personRequestTailCharacters = 3_000;

/** How many requests for one Skill are in flight at once. */
export const defaultConcurrency = 6;

/** One request's deadline. Requests run together, so this bounds the whole check. */
export const defaultTimeoutMs = 15_000;

/** The person's message, bounded. */
export function boundedPersonRequest(message: string): string {
  const text = message.trim();
  return text.length <= personRequestHeadCharacters + personRequestTailCharacters
    ? text
    : `${text.slice(0, personRequestHeadCharacters)}\n[...]\n${text.slice(-personRequestTailCharacters)}`;
}

function roleOfPath(path: string): SkillManifestEntry["role"] {
  if (path.startsWith("scripts/")) return "script";
  if (path.startsWith("references/")) return "reference";
  if (path.startsWith("assets/")) return "asset";
  return "other file";
}

/**
 * The Skill as one or more request states. Every request carries the same
 * person request, source, instructions and file manifest, and asks all seven
 * questions together, so no file is judged apart from the instructions that
 * use it.
 */
export function skillSafetyStates(input: {
  skill: ParsedSkill;
  personRequest: string;
  source: SkillSource;
  files: SkillFilesForCheck;
}): SkillSafetyState[] {
  const { skill, files: checked } = input;
  const allPaths = ["SKILL.md", ...checked.files.map((file) => file.path), ...checked.dataAssets];
  const namesIn = (text: string, self: string): string[] =>
    allPaths.filter(
      (path) => path !== self && (text.includes(path) || text.includes(path.split("/").at(-1) ?? path)),
    );
  const manifest: SkillManifestEntry[] = [
    { path: "SKILL.md", role: "instructions", names_files: namesIn(skill.bodyMarkdown, "SKILL.md") },
    ...checked.files.map((file) => ({
      path: file.path,
      role: file.role,
      names_files: namesIn(file.text, file.path),
    })),
    ...checked.dataAssets.map((path) => ({
      path,
      role: "data asset" as const,
      names_files: [],
    })),
  ];
  const shared = {
    person_request: boundedPersonRequest(input.personRequest),
    source: input.source,
    skill: {
      name: skill.name,
      description: skill.description,
      instructions: skill.bodyMarkdown.slice(0, instructionsCharacters),
    },
    files: manifest,
  };
  const instructionsWhole = skill.bodyMarkdown.length <= instructionsCharacters;
  const readable: {
    path: string;
    role: SkillFileRole;
    read_as: SkillDocument["read_as"];
    text: string;
  }[] = [
    ...(instructionsWhole
      ? []
      : [{ path: "SKILL.md", role: "instructions" as const, read_as: "text" as const, text: skill.bodyMarkdown }]),
    ...[...checked.files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({
        path: file.path,
        role: file.role,
        read_as: file.readAs,
        text: file.text,
      })),
  ];
  const budget = requestTextCharacters;
  const pieces: SkillDocument[] = [];
  for (const file of readable) {
    const partCount = Math.max(1, Math.ceil(file.text.length / budget));
    for (let part = 0; part < partCount; part += 1) {
      pieces.push({
        path: file.path,
        role: file.role as SkillDocument["role"],
        read_as: file.read_as,
        part_number: part + 1,
        part_count: partCount,
        text: file.text.slice(part * budget, (part + 1) * budget),
      });
    }
  }
  const states: SkillSafetyState[] = [];
  let current: SkillDocument[] = [];
  let used = 0;
  for (const piece of pieces) {
    if (current.length > 0 && used + piece.text.length > budget) {
      states.push({ ...shared, documents: current });
      current = [];
      used = 0;
    }
    current.push(piece);
    used += piece.text.length;
  }
  states.push({ ...shared, documents: current });
  return states;
}

/** Each question's largest answer across every request about one Skill. */
export function maxProbabilities(
  results: readonly Readonly<Record<QuestionId, number>>[],
  ids: readonly QuestionId[],
): Record<QuestionId, number> {
  const maxima = Object.fromEntries(ids.map((id) => [id, 0])) as Record<QuestionId, number>;
  for (const result of results) {
    for (const id of ids) maxima[id] = Math.max(maxima[id], result[id]);
  }
  return maxima;
}

export { roleOfPath };
