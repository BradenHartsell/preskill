/**
 * The question set's identity. The hash covers the questions and the default
 * floor, so any wording or policy change makes the old measurement stale.
 */

import { skillSafetyQuestions, skillSafetyQuestionsV2 } from "./questions.js";
import type { Ruleset } from "./types.js";

export const questionSetId = "skill_install_safety";
export const questionSetName = "skill-install-safety-v9-oss";
export const defaultRefuseFloor = 0.05;

/** Recomputed by the test suite; changing the questions changes this hash. */
export const questionSetContentHash = "38554836eb061d76";

export const questionSetVersion = `${questionSetName}#${questionSetContentHash}`;

/**
 * Ruleset v2 (opt-in). Its questions are the source checker's later revision
 * with the same name substitutions as v1; see PORTING.md.
 */
export const questionSetNameV2 = "skill-install-safety-v11-oss";

/** Recomputed by the test suite; changing the v2 questions changes this hash. */
export const questionSetContentHashV2 = "b14bc9c5e96937f5";

export const questionSetVersionV2 = `${questionSetNameV2}#${questionSetContentHashV2}`;

/** The question set version a ruleset reports in `SkillScanResult.questionSetVersion`. */
export function questionSetVersionFor(ruleset: Ruleset = "v1"): string {
  return ruleset === "v2" ? questionSetVersionV2 : questionSetVersion;
}

/** Stable JSON: object keys sorted, so the hash does not depend on source order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** The canonical content a ruleset's hash covers. Default v1. */
export function questionSetContent(ruleset: Ruleset = "v1"): string {
  return canonicalJson({
    id: questionSetId,
    questions: ruleset === "v2" ? skillSafetyQuestionsV2 : skillSafetyQuestions,
    policy: { refuse_floor: defaultRefuseFloor },
  });
}

export async function computeQuestionSetContentHash(ruleset: Ruleset = "v1"): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(questionSetContent(ruleset))),
  );
  return [...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
