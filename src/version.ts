/**
 * The question set's identity. The hash covers the questions and the default
 * floor, so any wording or policy change makes the old measurement stale.
 */

import { skillSafetyQuestions } from "./questions.js";

export const questionSetId = "skill_install_safety";
export const questionSetName = "skill-install-safety-v9-oss";
export const defaultRefuseFloor = 0.05;

/** Recomputed by the test suite; changing the questions changes this hash. */
export const questionSetContentHash = "38554836eb061d76";

export const questionSetVersion = `${questionSetName}#${questionSetContentHash}`;

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

export function questionSetContent(): string {
  return canonicalJson({
    id: questionSetId,
    questions: skillSafetyQuestions,
    policy: { refuse_floor: defaultRefuseFloor },
  });
}

export async function computeQuestionSetContentHash(): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(questionSetContent())),
  );
  return [...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
