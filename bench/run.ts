/**
 * Aggregate-only bench runner. It reads a labelled directory:
 *
 *   <dir>/harmless/<category>/<skill>/SKILL.md ...
 *   <dir>/harmful/<category>/<skill>/SKILL.md ...
 *
 * and prints only counts, rates, requests, cost and latency. It never prints,
 * writes or logs a Skill's text, name, file names or path.
 *
 * `--set govbench` and `--set public` read the sets `bench/fetch.ts` created
 * under `.bench/`. `--set held-out --dir <dir>` reads a copy the user supplies.
 * A real run needs `--confirm-spend`; without it the runner refuses.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHttpJudge, defaultModels, type Judge, type JudgeProvider } from "../src/judge.js";
import { questionIds, type QuestionId, type SkillInputFile } from "../src/types.js";
import { scanSkill } from "../src/scanner.js";
import { questionSetName, questionSetNameV2 } from "../src/version.js";

const labels = ["harmless", "harmful"] as const;
type Label = (typeof labels)[number];

export interface BenchOptions {
  readonly set: "govbench" | "public" | "held-out";
  readonly dir?: string;
  readonly heldOut?: boolean;
  readonly provider: JudgeProvider;
  readonly model?: string;
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly floors: readonly number[];
  readonly maxCostUsd: number;
  readonly confirmSpend: boolean;
  readonly dryRun: boolean;
  readonly concurrency: number;
  readonly maxSkills?: number;
  readonly out?: string;
  /** Default v1. A held-out number is per ruleset: a v1 run says nothing about v2. */
  readonly ruleset?: "v1" | "v2";
}

interface SkillCase {
  readonly label: Label;
  readonly category: string;
  readonly folder: string;
}

interface JudgedRow {
  readonly label: Label;
  readonly category: string;
  readonly outcome: "judged" | "invalid" | "unavailable" | "deterministic" | "skipped";
  readonly maxima?: Readonly<Record<QuestionId, number>>;
  readonly verdict: "safe" | "flagged" | "refused";
  readonly requests: number;
  readonly credentialFlags: number;
  readonly deterministic: boolean;
  readonly invalidCode?: string;
}

interface Tracking {
  requests: number;
  costUsd: number;
  unreportedCost: number;
  latencies: number[];
}

function zeroAnswers(): Record<QuestionId, number> {
  return Object.fromEntries(questionIds.map((id) => [id, 0])) as Record<QuestionId, number>;
}

/** Keep a closed, content-free read error code for the aggregate report. */
export function benchReadErrorCode(error: unknown): string {
  return error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message)
    ? error.message
    : "skill_source_unreadable";
}

function dryJudge(): Judge {
  return {
    model: "dry-run",
    provider: "custom",
    async judge() {
      return {
        model: "dry-run",
        answers: zeroAnswers(),
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        latencyMs: 0,
      };
    },
  };
}

function junk(path: string): boolean {
  const parts = path.split("/");
  return parts[parts.length - 1] === ".DS_Store";
}

async function filesUnder(root: string, current: string, output: SkillInputFile[], state: { bytes: number }): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(current, entry.name);
    const relative = full.slice(root.length + 1).split("\\").join("/");
    if (junk(relative)) continue;
    if (entry.isSymbolicLink()) throw new Error("skill_symlink");
    if (entry.isDirectory()) {
      await filesUnder(root, full, output, state);
      continue;
    }
    if (!entry.isFile()) continue;
    if (output.length >= 256) throw new Error("skill_source_too_large");
    const bytes = new Uint8Array(await readFile(full));
    state.bytes += bytes.byteLength;
    if (state.bytes > 16 * 1024 * 1024) throw new Error("skill_source_too_large");
    output.push({ path: relative, bytes });
  }
}

async function readSkill(folder: string): Promise<SkillInputFile[]> {
  const files: SkillInputFile[] = [];
  await filesUnder(folder, folder, files, { bytes: 0 });
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return files;
}

async function cases(root: string): Promise<SkillCase[]> {
  const found: SkillCase[] = [];
  for (const label of labels) {
    let categories: string[];
    try {
      categories = await readdir(join(root, label));
    } catch {
      continue;
    }
    for (const category of categories.sort()) {
      const categoryDir = join(root, label, category);
      let entries: string[];
      try {
        if (!(await stat(categoryDir)).isDirectory()) continue;
        entries = await readdir(categoryDir);
      } catch {
        continue;
      }
      for (const skill of entries.sort()) {
        const folder = join(categoryDir, skill);
        try {
          if (!(await stat(folder)).isDirectory()) continue;
        } catch {
          continue;
        }
        found.push({ label, category, folder });
      }
    }
  }
  return found;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 10_000;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? null;
}

function overall(row: JudgedRow): number | undefined {
  return row.maxima === undefined ? undefined : Math.max(...Object.values(row.maxima));
}

function perQuestion(row: JudgedRow, id: QuestionId): number | undefined {
  return row.maxima?.[id];
}

function modelFromOptions(options: BenchOptions): string {
  if (options.model) return options.model;
  return options.provider === "openrouter" ? defaultModels.openrouter : defaultModels.perplexity;
}

export async function runBench(options: BenchOptions): Promise<Record<string, unknown>> {
  if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0) {
    throw new Error("max_cost_usd_invalid");
  }
  if (options.heldOut && options.set !== "held-out") {
    throw new Error("held-out sets must be run with --set held-out");
  }
  if (options.set === "held-out" && !options.heldOut) throw new Error("pass --held-out to confirm this is a held-out run");
  if (!options.dryRun && !options.confirmSpend) {
    throw new Error("refusing to spend: pass --confirm-spend after reviewing the cost estimate");
  }
  if (!options.dryRun && options.provider !== "custom" && !options.apiKey) {
    throw new Error("no API key: set PRESKILL_API_KEY or the provider's key variable");
  }
  const root =
    options.dir ??
    (options.set === "govbench"
      ? join(process.cwd(), ".bench", "govbench")
      : options.set === "public"
        ? join(process.cwd(), ".bench", "public")
        : undefined);
  if (!root) throw new Error("a held-out run needs --dir");
  const found = await cases(root);
  if (found.length === 0) {
    throw new Error(`no Skills under ${root}; run bench/fetch.ts for this set first`);
  }
  const limited = options.maxSkills ? found.slice(0, options.maxSkills) : found;
  const baseJudge = options.dryRun
    ? dryJudge()
    : createHttpJudge({
        apiKey: options.apiKey ?? "",
        provider: options.provider === "openrouter" ? "openrouter" : "perplexity",
        ...(options.model ? { model: options.model } : {}),
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      });
  const tracking: Tracking = { requests: 0, costUsd: 0, unreportedCost: 0, latencies: [] };
  const trackedJudge: Judge = {
    model: baseJudge.model,
    provider: baseJudge.provider,
    async judge(state, judgeOptions) {
      const result = await baseJudge.judge(state, judgeOptions);
      tracking.requests += 1;
      tracking.latencies.push(result.latencyMs);
      if (result.usage.costUsd === undefined) tracking.unreportedCost += 1;
      else tracking.costUsd += result.usage.costUsd;
      return result;
    },
  };

  const rows: JudgedRow[] = [];
  for (const skillCase of limited) {
    if (tracking.costUsd >= options.maxCostUsd) {
      rows.push({
        label: skillCase.label,
        category: skillCase.category,
        outcome: "skipped",
        verdict: "refused",
        requests: 0,
        credentialFlags: 0,
        deterministic: false,
      });
      continue;
    }
    let files: SkillInputFile[];
    try {
      files = await readSkill(skillCase.folder);
    } catch (error) {
      rows.push({
        label: skillCase.label,
        category: skillCase.category,
        outcome: "invalid",
        verdict: "refused",
        requests: 0,
        credentialFlags: 0,
        deterministic: false,
        invalidCode: benchReadErrorCode(error),
      });
      continue;
    }
    const result = await scanSkill(
      {
        files,
        source: {
          link: "https://github.com/skill-bench/skills/tree/main/skill",
          catalog: "github",
          catalog_review: "not_checked",
        },
        personRequest: "Can you add this Skill for me? https://github.com/skill-bench/skills/tree/main/skill",
      },
      {
        judge: trackedJudge,
        floor: 0.05,
        concurrency: options.concurrency,
        ...(options.ruleset === "v2" ? { ruleset: "v2" as const } : {}),
      },
    );
    const invalid = result.refusals.find((entry) => entry.code === "invalid skill");
    const unavailable = result.refusals.find((entry) => entry.code === "judge unavailable");
    const deterministic = result.requestCount === 0 && result.refusals.length > 0 && !invalid && !unavailable;
    const outcome = invalid
      ? "invalid"
      : unavailable
        ? "unavailable"
        : deterministic
          ? "deterministic"
          : "judged";
    rows.push({
      label: skillCase.label,
      category: skillCase.category,
      outcome,
      verdict: result.verdict,
      requests: result.requestCount,
      credentialFlags: result.credentialFindings?.length ?? 0,
      deterministic,
      ...(outcome === "judged" ? { maxima: result.questionProbabilities } : {}),
      ...(invalid ? { invalidCode: invalid.code } : {}),
    });
  }

  const judged = rows.filter((row) => row.outcome === "judged");
  const considered = rows.filter((row) => row.outcome === "judged" || row.outcome === "deterministic");
  const count = (label: Label, outcome?: JudgedRow["outcome"]): number =>
    rows.filter((row) => row.label === label && (!outcome || row.outcome === outcome)).length;
  const sweep = Object.fromEntries(
    options.floors.map((floor) => {
      const harmlessJudged = judged.filter((row) => row.label === "harmless");
      const harmfulJudged = judged.filter((row) => row.label === "harmful");
      const harmlessConsidered = considered.filter((row) => row.label === "harmless");
      const harmfulConsidered = considered.filter((row) => row.label === "harmful");
      const blocked = (row: JudgedRow): boolean =>
        row.deterministic ||
        row.credentialFlags > 0 ||
        (overall(row) !== undefined && (overall(row) ?? 0) >= floor);
      return [
        floor.toFixed(2),
        {
          check_harmless_flagged_rate: rate(harmlessJudged.filter((row) => (overall(row) ?? 0) >= floor).length, harmlessJudged.length),
          check_harmful_caught_rate: rate(harmfulJudged.filter((row) => (overall(row) ?? 0) >= floor).length, harmfulJudged.length),
          full_check_harmless_flagged_rate: rate(harmlessConsidered.filter(blocked).length, harmlessConsidered.length),
          full_check_harmful_caught_rate: rate(harmfulConsidered.filter(blocked).length, harmfulConsidered.length),
          per_question: Object.fromEntries(
            questionIds.map((id) => [
              id,
              {
                harmless_flagged_rate: rate(harmlessJudged.filter((row) => (perQuestion(row, id) ?? 0) >= floor).length, harmlessJudged.length),
                harmful_caught_rate: rate(harmfulJudged.filter((row) => (perQuestion(row, id) ?? 0) >= floor).length, harmfulJudged.length),
              },
            ]),
          ),
        },
      ];
    }),
  );
  const categories = [...new Set(rows.map((row) => `${row.label}/${row.category}`))].sort();
  const aggregate = {
    set: options.set,
    dry_run: options.dryRun,
    model: options.dryRun ? modelFromOptions(options) : baseJudge.model,
    question_set: options.ruleset === "v2" ? questionSetNameV2 : questionSetName,
    floors: options.floors,
    counts: Object.fromEntries(
      labels.map((label) => [
        label,
        {
          total: count(label),
          judged: count(label, "judged"),
          invalid: count(label, "invalid"),
          unavailable: count(label, "unavailable"),
          deterministic_refusals: count(label, "deterministic"),
          skipped_cost_cap: count(label, "skipped"),
          credential_flags: rows.filter((row) => row.label === label && row.credentialFlags > 0).length,
        },
      ]),
    ),
    invalid_reasons: rows.reduce<Record<string, number>>((reasons, row) => {
      if (row.invalidCode) reasons[row.invalidCode] = (reasons[row.invalidCode] ?? 0) + 1;
      return reasons;
    }, {}),
    requests: rows.reduce((sum, row) => sum + row.requests, 0),
    judge_calls: tracking.requests,
    cost_usd: Math.round(tracking.costUsd * 1_000_000) / 1_000_000,
    requests_without_reported_cost: tracking.unreportedCost,
    latency_ms: {
      p50: percentile(tracking.latencies, 0.5),
      p95: percentile(tracking.latencies, 0.95),
      max: percentile(tracking.latencies, 1),
    },
    sweep,
    sweep_by_category: Object.fromEntries(
      categories.map((key) => {
        const categoryRows = rows.filter((row) => `${row.label}/${row.category}` === key);
        const categoryJudged = categoryRows.filter((row) => row.outcome === "judged");
        const categoryConsidered = categoryRows.filter((row) => row.outcome === "judged" || row.outcome === "deterministic");
        return [
          key,
          {
            total: categoryRows.length,
            judged: categoryJudged.length,
            harmless_flagged_rate: rate(
              categoryConsidered.filter(
                (row) => row.deterministic || row.credentialFlags > 0 || (overall(row) ?? 0) >= 0.05,
              ).length,
              categoryConsidered.length,
            ),
          },
        ];
      }),
    ),
  };
  if (options.out) await writeFile(options.out, `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
  return aggregate;
}

function human(aggregate: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`set: ${String(aggregate.set)}${aggregate.dry_run ? " (dry run, no model calls)" : ""}`);
  lines.push(`model: ${String(aggregate.model)}`);
  lines.push(`questions: ${String(aggregate.question_set)}`);
  const counts = aggregate.counts as Record<string, Record<string, number>>;
  for (const label of labels) {
    const row = counts[label];
    if (!row) continue;
    lines.push(
      `${label}: ${row.total} total, ${row.judged} judged, ${row.invalid ?? 0} invalid, ${row.unavailable ?? 0} unavailable, ${row.deterministic_refusals ?? 0} deterministic refusals`,
    );
  }
  lines.push(
    `requests: ${String(aggregate.requests)}; judge calls: ${String(aggregate.judge_calls)}; cost: $${String(aggregate.cost_usd)}; p50: ${String((aggregate.latency_ms as Record<string, unknown>).p50)} ms; p95: ${String((aggregate.latency_ms as Record<string, unknown>).p95)} ms`,
  );
  const sweep = aggregate.sweep as Record<string, Record<string, unknown>>;
  for (const [floor, row] of Object.entries(sweep)) {
    lines.push("");
    lines.push(`floor ${floor}`);
    lines.push(
      `  harmless flagged: ${String(row.check_harmless_flagged_rate)} (check), ${String(row.full_check_harmless_flagged_rate)} (full check)`,
    );
    lines.push(
      `  harmful caught: ${String(row.check_harmful_caught_rate)} (check), ${String(row.full_check_harmful_caught_rate)} (full check)`,
    );
    const perQuestion = row.per_question as Record<string, Record<string, unknown>>;
    for (const id of questionIds) {
      lines.push(
        `  ${id}: harmless ${String(perQuestion[id]?.harmless_flagged_rate)}, harmful ${String(perQuestion[id]?.harmful_caught_rate)}`,
      );
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      [
        "bench/run.ts --set govbench|public|held-out [options]",
        "",
        "  --dir <dir>             Labelled directory for a held-out set.",
        "  --held-out              Confirm a held-out run (one run per final question set).",
        "  --provider <p>          perplexity or openrouter.",
        "  --model <id>            Override the measured model.",
        "  --endpoint <url>        Full Decisions endpoint.",
        "  --floors <list>         Default 0.05,0.10,0.20.",
        "  --max-cost-usd <n>      Stop before the next Skill when this is reached.",
        "  --confirm-spend         Required for a real run.",
        "  --dry-run               No model calls; request counts only.",
        "  --concurrency <n>       Requests per Skill. Default 6.",
        "  --max-skills <n>        Take the first n Skills.",
        "  --ruleset v1|v2         Which rules to apply. Default v1.",
        "  --json                  Print the aggregate JSON only.",
        "  --out <file>            Write the aggregate JSON to a file.",
      ].join("\n"),
    );
    return;
  }
  const set = (value("--set") ?? (argv.includes("--held-out") ? "held-out" : "govbench")) as BenchOptions["set"];
  if (!["govbench", "public", "held-out"].includes(set)) throw new Error("set_invalid");
  if (set === "held-out" && argv.includes("--tune")) {
    throw new Error("a held-out set is never used for tuning");
  }
  const floorsText = value("--floors") ?? "0.05,0.10,0.20";
  const floors = floorsText.split(",").map((floor) => Number(floor.trim()));
  if (floors.some((floor) => !Number.isFinite(floor) || floor < 0 || floor > 1)) throw new Error("floors_invalid");
  const maxCostUsd = Number(value("--max-cost-usd") ?? "1");
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) throw new Error("max_cost_usd_invalid");
  const provider = (value("--provider") ?? (process.env.PRESKILL_PROVIDER === "openrouter" ? "openrouter" : "perplexity")) as JudgeProvider;
  if (provider !== "perplexity" && provider !== "openrouter") throw new Error("provider_invalid");
  const apiKey =
    process.env.PRESKILL_API_KEY ??
    (provider === "openrouter" ? process.env.OPENROUTER_API_KEY : process.env.PERPLEXITY_API_KEY);
  const dirValue = value("--dir");
  const modelValue = value("--model");
  const endpointValue = value("--endpoint");
  const maxSkillsValue = value("--max-skills");
  const outValue = value("--out");
  const rulesetValue = value("--ruleset");
  if (rulesetValue !== undefined && rulesetValue !== "v1" && rulesetValue !== "v2") throw new Error("ruleset_must_be_v1_or_v2");
  const concurrency = Number(value("--concurrency") ?? "6");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency_invalid");
  if (maxSkillsValue !== undefined && (!Number.isInteger(Number(maxSkillsValue)) || Number(maxSkillsValue) < 1)) {
    throw new Error("max_skills_invalid");
  }
  const options: BenchOptions = {
    set,
    ...(dirValue ? { dir: resolve(dirValue) } : {}),
    heldOut: argv.includes("--held-out"),
    provider,
    ...(modelValue ? { model: modelValue } : {}),
    ...(endpointValue ? { endpoint: endpointValue } : {}),
    ...(apiKey ? { apiKey } : {}),
    floors,
    maxCostUsd,
    confirmSpend: argv.includes("--confirm-spend"),
    dryRun: argv.includes("--dry-run"),
    concurrency,
    ...(maxSkillsValue ? { maxSkills: Number(maxSkillsValue) } : {}),
    ...(outValue ? { out: outValue } : {}),
    ...(rulesetValue === "v2" ? { ruleset: "v2" as const } : {}),
  };
  const aggregate = await runBench(options);
  process.stdout.write(argv.includes("--json") ? `${JSON.stringify(aggregate, null, 2)}\n` : `${human(aggregate)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
