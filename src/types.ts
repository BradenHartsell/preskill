/**
 * A Skill is a folder holding SKILL.md plus any scripts, references and data
 * its author ships. `SkillInputFile` is the one input shape: a path inside the
 * Skill and the exact bytes at that path. Nothing here executes those bytes.
 */
export interface SkillInputFile {
  /** A relative path with forward slashes, never empty and never containing `..`. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** Where the Skill was read from. Kept as the same three facts the judge sees. */
export interface SkillSource {
  /** The link (or local path) the person supplied. */
  readonly link: string;
  readonly catalog: "clawhub" | "skills.sh" | "github" | "web";
  /** A catalog's own automated review of these exact files, when one exists. */
  readonly catalog_review: "clean" | "suspicious" | "not_checked";
}

/** What the person asked for, plus the files and where they came from. */
export interface SkillScanInput {
  readonly files: readonly SkillInputFile[];
  readonly source: SkillSource;
  /** The person's own words that carried the link. Bounded by the scanner. */
  readonly personRequest?: string;
  /** Files the Skill named that the source could not return. */
  readonly missingFiles?: readonly {
    readonly path: string;
    readonly reason: "not_found" | "unavailable" | "unsafe_path" | "too_large";
  }[];
}

/** The seven question names. */
export const questionIds = [
  "takes_person_data_elsewhere",
  "deceives_the_person",
  "hides_actions_from_the_person",
  "harms_other_people",
  "collects_person_secrets",
  "runs_harmful_software",
  "overrides_agent_safeguards",
] as const;

export type QuestionId = (typeof questionIds)[number];

/** How a file is read: as text, or by one of the optional readers. */
export type SkillReadAs =
  | "text"
  | "document text"
  | "visual reading"
  | "archive entry text"
  | "bytecode strings";

/** What the Skill does with a file. */
export type SkillFileRole = "instructions" | "script" | "reference" | "asset" | "other file";

/** One readable piece of the Skill, before request splitting. */
export interface SkillCheckFile {
  readonly path: string;
  readonly role: SkillFileRole;
  readonly readAs: SkillReadAs;
  readonly text: string;
}

/** Why one file could not be read. */
export type FileRefusalCode =
  | "compiled native program"
  | "damaged or password-protected"
  | "unknown binary format"
  | "archive too large or too deep"
  | "unsafe path"
  | "unreadable file type"
  | "symlink";

/** Every hard refusal the scanner can return. */
export type RefusalCode =
  | FileRefusalCode
  | "encoded code"
  | "missing named file"
  | "judge unavailable"
  | "reader unavailable"
  | "invalid configuration"
  | "invalid skill";

/** One hard refusal, with a plain sentence for the person. */
export interface ScanRefusal {
  readonly path?: string;
  readonly code: RefusalCode;
  readonly reason: string;
}

/** One file nothing could read, in plain words. */
export interface SkillFileRefusal {
  readonly path: string;
  readonly code: FileRefusalCode;
  readonly reason: string;
}

/** The result of reading every file in a Skill. */
export interface SkillFilesForCheck {
  /** Every readable file except SKILL.md, in path order. */
  readonly files: readonly SkillCheckFile[];
  /** Files with no readable text that the Skill never names. */
  readonly dataAssets: readonly string[];
  readonly refusals: readonly SkillFileRefusal[];
}

/** One entry of the manifest carried in every judge request. */
export interface SkillManifestEntry {
  readonly path: string;
  readonly role: SkillFileRole | "data asset";
  /** Other files of this Skill that this file's text names. */
  readonly names_files: readonly string[];
}

/** One request's share of the Skill's text. */
export interface SkillDocument {
  readonly path: string;
  readonly role: SkillFileRole;
  readonly read_as: SkillReadAs;
  readonly part_number: number;
  readonly part_count: number;
  readonly text: string;
}

/** Exactly what one judge request reads. */
export interface SkillSafetyState {
  readonly person_request: string;
  readonly source: SkillSource;
  readonly skill: {
    readonly name: string;
    readonly description: string;
    /** SKILL.md, or its head when longer than the per-request bound. */
    readonly instructions: string;
  };
  /** Every file in the Skill, in every request. */
  readonly files: readonly SkillManifestEntry[];
  /** This request's share of the file text, in path order. */
  readonly documents: readonly SkillDocument[];
}

/** A parsed and minimally validated SKILL.md. */
export interface ParsedSkill {
  readonly name: string;
  readonly description: string;
  readonly bodyMarkdown: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly declarations?: Readonly<Record<string, string>>;
}

/** Optional readers. Without them, documents and named images are hard refusals. */
export interface SkillFileReader {
  /** Selectable text from a document, or null when it has none. */
  documentText?(bytes: Uint8Array, mimeType: string, path: string): Promise<string | null>;
  /** What a visual reader sees in an image or a scanned page. */
  describeVisual?(input: { bytes: Uint8Array; mimeType: string; path: string }): Promise<string>;
}

/** A reader failed during file review; the scanner turns this into a refusal. */
export class SkillReaderError extends Error {
  constructor() {
    super("skill_reader_failed");
    this.name = "SkillReaderError";
  }
}

/** One credential-shaped value, by file and line. The value itself is never returned. */
export interface CredentialFinding {
  readonly file: string;
  readonly lines: readonly number[];
}

/** One sentence a caller can show. */
export interface ScanReason {
  readonly kind: "question" | "credential" | "file" | "fetch" | "check";
  readonly question?: QuestionId;
  readonly path?: string;
  readonly sentence: string;
}

/** The one result a caller shows to a person. */
export interface SkillScanResult {
  /**
   * `safe` adds it. `flagged` brings it to the person with the reasons: the
   * person may still choose to add it. `refused` is a hard stop: encoded code
   * that is decoded and run, a file the Skill uses that nothing can read, a
   * named file that could not be fetched, or a judge that could not answer.
   */
  readonly verdict: "safe" | "flagged" | "refused";
  readonly questionProbabilities: Readonly<Record<QuestionId, number>>;
  readonly flaggedQuestions: readonly QuestionId[];
  readonly flaggedPaths: readonly string[];
  readonly pathsByQuestion: Readonly<Partial<Record<QuestionId, readonly string[]>>>;
  readonly refusals: readonly ScanRefusal[];
  readonly reasons: {
    /** One sentence per flagged question, in `flaggedQuestions` order. */
    readonly questions: Readonly<Partial<Record<QuestionId, string>>>;
    /** Credential, file, fetch and check sentences. */
    readonly other: readonly string[];
  };
  /** How many judge requests were sent. Zero when a deterministic rule stopped the check. */
  readonly requestCount: number;
  /** The model the provider reported, or the configured model when no request was sent. */
  readonly model: string;
  /** The ported question set and its content hash. */
  readonly questionSetVersion: string;
  /** Present when the scan produced credential findings. */
  readonly credentialFindings?: readonly CredentialFinding[];
}
