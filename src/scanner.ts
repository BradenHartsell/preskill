/**
 * The scanner itself. It reads the Skill, runs the deterministic rules first,
 * asks the judge about every request, then combines the answers:
 *
 * - each question takes its largest answer across requests;
 * - a question at or above the floor flags the Skill and names the files of
 *   the request that carried the answer, plus SKILL.md;
 * - a credential-shaped value flags the file by line, never by value;
 * - only encoded-then-run code, an unreadable file the Skill uses, a missing
 *   named file, an invalid Skill or a judge failure refuses outright.
 */

import { findCredentialValueMatches } from "./credentials.js";
import { skillEncodedCodeFiles, skillFilesForCheck } from "./file-review.js";
import type { Judge, JudgeFailureKind } from "./judge.js";
import { JudgeError } from "./judge.js";
import { asSentence, questionReasons } from "./questions.js";
import { parseSkillFolder, SkillFormatError } from "./skill.js";
import { decodeManifestText } from "./text.js";
import {
  boundedPersonRequest,
  defaultConcurrency,
  defaultTimeoutMs,
  maxProbabilities,
  skillSafetyStates,
} from "./split.js";
import type {
  CredentialFinding,
  QuestionId,
  ScanRefusal,
  SkillFileReader,
  SkillFilesForCheck,
  SkillScanInput,
  SkillScanResult,
  SkillSource,
} from "./types.js";
import { SkillReaderError, questionIds } from "./types.js";
import { defaultRefuseFloor, questionSetVersion } from "./version.js";

export interface ScanOptions {
  /** The judge to ask. A caller without one should use `createHttpJudge`. */
  readonly judge: Judge;
  /** Default 0.05. A question at or above this flags the Skill. */
  readonly floor?: number;
  /** How many requests for one Skill are in flight at once. Default 6. */
  readonly concurrency?: number;
  /** One request's deadline. Default 15 seconds. */
  readonly timeoutMs?: number;
  /** The person's own words. Defaults to a neutral request carrying the link. */
  readonly personRequest?: string;
  /** Optional document or visual readers. */
  readonly reader?: SkillFileReader;
  readonly signal?: AbortSignal;
  /** Local-only observation of each answered request; never sent anywhere. */
  readonly onJudgeResult?: (result: { requestIndex: number; requestCount: number }) => void;
}

function zeroAnswers(): Record<QuestionId, number> {
  return Object.fromEntries(questionIds.map((id) => [id, 0])) as Record<QuestionId, number>;
}

function refusalSentence(code: string): string {
  switch (code) {
    case "skill_manifest_missing":
      return "There is no readable SKILL.md at the top of the Skill.";
    case "skill_manifest_encoding_invalid":
      return "SKILL.md is not UTF-8 text.";
    case "skill_manifest_frontmatter_missing":
      return "SKILL.md does not start with a name and description block.";
    case "skill_manifest_name_invalid":
      return "The Skill's name is missing or is not a valid lowercase name.";
    case "skill_manifest_description_invalid":
      return "The Skill's description is missing or too long.";
    case "skill_manifest_compatibility_invalid":
      return "The Skill's compatibility line is too long.";
    case "skill_source_path_invalid":
      return "One of the Skill's file paths is not a plain relative path.";
    case "skill_source_duplicate_path":
      return "The Skill has two files at the same path.";
    case "skill_file_contents_invalid":
      return "One of the Skill's files is not readable content.";
    default:
      return "The Skill's SKILL.md could not be read.";
  }
}

function missingSentence(path: string, reason: "not_found" | "unavailable" | "unsafe_path" | "too_large"): string {
  const why =
    reason === "not_found"
      ? "it was not found at the source"
      : reason === "unavailable"
        ? "the source did not return it"
        : reason === "too_large"
          ? "it is larger than the size limit for one Skill"
          : "its path is not a safe relative path";
  return `${path} is named by the Skill but could not be read: ${why}.`;
}

function judgeSentence(kind: JudgeFailureKind): string {
  switch (kind) {
    case "unauthorized":
      return "The judge refused the API key, so the Skill was not checked. Nothing should be installed.";
    case "payment_required":
      return "The judge account needs payment, so the Skill was not checked. Nothing should be installed.";
    case "rate_limited":
      return "The judge was rate-limited, so the Skill was not checked. Nothing should be installed.";
    case "timeout":
      return "The judge did not answer in time, so the Skill was not checked. Nothing should be installed.";
    case "aborted":
      return "The check was stopped, so the Skill was not checked. Nothing should be installed.";
    case "response_invalid":
      return "The judge's answer did not fit the question set, so the Skill was not checked. Nothing should be installed.";
    case "request_invalid":
      return "The check could not build a valid request, so the Skill was not checked. Nothing should be installed.";
    default:
      return "The judge could not be reached, so the Skill was not checked. Nothing should be installed.";
  }
}

/** The files holding a credential-shaped value, by line. Values never leave this function. */
export function skillCredentialFindings(
  skill: { name: string; description: string; bodyMarkdown: string },
  files: SkillFilesForCheck,
  manifestText?: string,
): CredentialFinding[] {
  const texts: { file: string; text: string }[] = [
    {
      file: "SKILL.md",
      text: manifestText ?? [skill.name, skill.description, skill.bodyMarkdown].join("\n"),
    },
    ...files.files.map((file) => ({ file: file.path, text: file.text })),
  ];
  return texts.flatMap(({ file, text }) => {
    const matches = findCredentialValueMatches(text);
    if (matches.length === 0) return [];
    const lines = [
      ...new Set(matches.map((match) => text.slice(0, match.start).split("\n").length)),
    ].sort((left, right) => left - right);
    return [{ file, lines }];
  });
}

function refusal(
  path: string | undefined,
  code: ScanRefusal["code"],
  reason: string,
): ScanRefusal {
  return { ...(path === undefined ? {} : { path }), code, reason };
}

async function judgeStates(
  states: ReturnType<typeof skillSafetyStates>,
  options: ScanOptions,
): Promise<{ answers: Record<QuestionId, number>[]; models: string[] }> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? defaultConcurrency, states.length));
  const results: Record<QuestionId, number>[] = new Array(states.length);
  const models: string[] = [];
  let next = 0;
  let failure: JudgeError | undefined;
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < states.length) {
      const index = next;
      next += 1;
      const state = states[index];
      if (!state) continue;
      try {
        const result = await options.judge.judge(state, {
          ...(options.signal ? { signal: options.signal } : {}),
          timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
        });
        for (const id of questionIds) {
          const value = result.answers[id];
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
            throw new JudgeError("response_invalid");
          }
        }
        results[index] = result.answers;
        models.push(result.model);
        options.onJudgeResult?.({ requestIndex: index, requestCount: states.length });
      } catch (error) {
        if (error instanceof JudgeError) {
          failure = error;
          return;
        }
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (failure) throw failure;
  return { answers: results, models };
}

/**
 * Scan one Skill. The result is the complete answer; this function does not
 * log, write, or send anything except the judge requests the caller supplied.
 */
export async function scanSkill(input: SkillScanInput, options: ScanOptions): Promise<SkillScanResult> {
  const floor = options.floor ?? defaultRefuseFloor;
  const concurrency = options.concurrency ?? defaultConcurrency;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const base = {
    questionProbabilities: zeroAnswers(),
    flaggedQuestions: [],
    flaggedPaths: [],
    pathsByQuestion: {},
    refusals: [],
    reasons: { questions: {}, other: [] },
    requestCount: 0,
    model: options.judge.model,
    questionSetVersion,
  } satisfies Omit<SkillScanResult, "verdict">;

  const invalidConfiguration = (sentence: string): SkillScanResult => {
    const entry = refusal(undefined, "invalid configuration", sentence);
    return {
      ...base,
      verdict: "refused",
      refusals: [entry],
      reasons: { questions: {}, other: [entry.reason] },
    };
  };
  if (!Number.isFinite(floor) || floor < 0 || floor > 1) {
    return invalidConfiguration("The scanner was configured with an invalid floor. Nothing was checked.");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    return invalidConfiguration("The scanner was configured with an invalid concurrency. Nothing was checked.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return invalidConfiguration("The scanner was configured with an invalid timeout. Nothing was checked.");
  }
  const scanOptions: ScanOptions = { ...options, floor, concurrency, timeoutMs };

  const missing = input.missingFiles ?? [];
  if (missing.length > 0) {
    const refusals = missing.map((file) =>
      refusal(file.path, "missing named file", missingSentence(file.path, file.reason)),
    );
    return {
      ...base,
      verdict: "refused",
      flaggedPaths: missing.map((file) => file.path).sort(),
      refusals,
      reasons: { questions: {}, other: refusals.map((entry) => entry.reason) },
    };
  }

  let parsed;
  try {
    parsed = parseSkillFolder(input.files, { lenientName: true });
  } catch (error) {
    if (!(error instanceof SkillFormatError)) throw error;
    const entry = refusal("SKILL.md", "invalid skill", refusalSentence(error.code));
    return {
      ...base,
      verdict: "refused",
      flaggedPaths: ["SKILL.md"],
      refusals: [entry],
      reasons: { questions: {}, other: [entry.reason] },
    };
  }
  const { skill, files } = parsed;
  let checked: SkillFilesForCheck;
  try {
    checked = await skillFilesForCheck(skill, files, options.reader);
  } catch (error) {
    if (!(error instanceof SkillReaderError)) throw error;
    const entry = refusal(
      undefined,
      "reader unavailable",
      "A document or image reader failed, so the Skill was not checked. Nothing should be installed.",
    );
    return {
      ...base,
      verdict: "refused",
      refusals: [entry],
      reasons: { questions: {}, other: [entry.reason] },
    };
  }
  const encoded = skillEncodedCodeFiles([{ path: "SKILL.md", text: skill.bodyMarkdown }, ...checked.files]);
  if (encoded.length > 0) {
    const refusals = encoded.map((path) =>
      refusal(
        path,
        "encoded code",
        `${path} hides code in an encoded form and then runs it; code that cannot be read as written is never allowed.`,
      ),
    );
    return {
      ...base,
      verdict: "refused",
      flaggedPaths: encoded,
      refusals,
      reasons: { questions: {}, other: refusals.map((entry) => entry.reason) },
    };
  }
  if (checked.refusals.length > 0) {
    return {
      ...base,
      verdict: "refused",
      flaggedPaths: checked.refusals.map((entry) => entry.path).sort(),
      refusals: checked.refusals,
      reasons: { questions: {}, other: checked.refusals.map((entry) => entry.reason) },
    };
  }

  const credentialFindings = skillCredentialFindings(
    skill,
    checked,
    decodeManifestText(files.find((file) => file.path === "SKILL.md")?.bytes ?? new Uint8Array()),
  );
  const source: SkillSource = input.source;
  const personRequest = boundedPersonRequest(
    options.personRequest ?? `Please add this Skill for me: ${source.link}`,
  );
  const states = skillSafetyStates({ skill, personRequest, source, files: checked });

  let judged: { answers: Record<QuestionId, number>[]; models: string[] };
  try {
    judged = await judgeStates(states, scanOptions);
  } catch (error) {
    if (!(error instanceof JudgeError)) throw error;
    const entry = refusal(undefined, "judge unavailable", judgeSentence(error.kind));
    return {
      ...base,
      verdict: "refused",
      requestCount: states.length,
      refusals: [entry],
      reasons: { questions: {}, other: [entry.reason] },
    };
  }

  const probabilities = maxProbabilities(judged.answers, questionIds);
  const flaggedQuestions = questionIds.filter((id) => probabilities[id] >= floor);
  const pathSets: Partial<Record<QuestionId, Set<string>>> = {};
  judged.answers.forEach((answers, index) => {
    const paths = ["SKILL.md", ...(states[index]?.documents ?? []).map((document) => document.path)];
    for (const id of questionIds) {
      if (answers[id] < floor) continue;
      const set = (pathSets[id] ??= new Set<string>());
      for (const path of paths) set.add(path);
    }
  });
  const pathsByQuestion = Object.fromEntries(
    flaggedQuestions.map((id) => [id, [...(pathSets[id] ?? [])].sort()]),
  ) as Partial<Record<QuestionId, string[]>>;
  const flaggedPaths = new Set<string>();
  for (const id of flaggedQuestions) for (const path of pathsByQuestion[id] ?? []) flaggedPaths.add(path);
  for (const finding of credentialFindings) flaggedPaths.add(finding.file);

  const reasonsOther: string[] = [];
  for (const finding of credentialFindings) {
    reasonsOther.push(
      `${finding.file} holds a value shaped like a real password or key (line ${
        finding.lines.join(", ")
      }).`,
    );
  }
  const reasonsQuestions = Object.fromEntries(
    flaggedQuestions.map((id) => [id, asSentence(questionReasons[id])]),
  ) as Partial<Record<QuestionId, string>>;

  const flagged = flaggedQuestions.length > 0 || credentialFindings.length > 0;
  const model = [...new Set(judged.models)].sort().join(",");
  return {
    verdict: flagged ? "flagged" : "safe",
    questionProbabilities: probabilities,
    flaggedQuestions,
    flaggedPaths: [...flaggedPaths].sort(),
    pathsByQuestion,
    refusals: [],
    reasons: { questions: reasonsQuestions, other: reasonsOther },
    requestCount: judged.answers.length,
    model: model || options.judge.model,
    questionSetVersion,
    ...(credentialFindings.length > 0 ? { credentialFindings } : {}),
  };
}
