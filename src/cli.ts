#!/usr/bin/env node
/**
 * `npx @vxbe/preskill scan <path-or-url>`.
 *
 * Reads a local folder, a zip, a GitHub URL or a raw SKILL.md URL, asks the
 * user's own judge, and prints the verdict. It never executes Skill content and
 * never sends anything except the judge requests and the Skill fetch.
 */

import { asSentence } from "./questions.js";
import { fetchSkillFromUrl } from "./fetch.js";
import { createHttpJudge } from "./judge.js";
import { readSkillTarget } from "./node.js";
import { scanSkill } from "./scanner.js";
import type { SkillInputFile, SkillScanResult, SkillSource } from "./types.js";

interface Args {
  target: string;
  provider?: "perplexity" | "openrouter";
  model?: string;
  endpoint?: string;
  floor?: number;
  personRequest?: string;
  concurrency?: number;
  timeoutMs?: number;
  json: boolean;
  keyEnv?: string;
  help: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { target: "", json: false, help: false };
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? "";
    const next = (): string => {
      const found = argv[index + 1];
      if (found === undefined) throw new Error(`missing value for ${value}`);
      index += 1;
      return found;
    };
    switch (value) {
      case "--provider": {
        const provider = next();
        if (provider !== "perplexity" && provider !== "openrouter") {
          throw new Error("provider_must_be_perplexity_or_openrouter");
        }
        args.provider = provider;
        break;
      }
      case "--model":
        args.model = next();
        break;
      case "--endpoint":
        args.endpoint = next();
        break;
      case "--floor": {
        const floor = Number(next());
        if (!Number.isFinite(floor) || floor < 0 || floor > 1) throw new Error("floor_must_be_between_0_and_1");
        args.floor = floor;
        break;
      }
      case "--person-request":
        args.personRequest = next();
        break;
      case "--concurrency": {
        const concurrency = Number(next());
        if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency_must_be_a_positive_integer");
        args.concurrency = concurrency;
        break;
      }
      case "--timeout-ms": {
        const timeoutMs = Number(next());
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeout_ms_invalid");
        args.timeoutMs = timeoutMs;
        break;
      }
      case "--key-env":
        args.keyEnv = next();
        break;
      case "--json":
        args.json = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (value.startsWith("-")) throw new Error(`unknown option ${value}`);
        positional.push(value);
        break;
    }
  }
  if (!args.help) {
    const [command, ...rest] = positional;
    if (command === "scan") {
      if (rest.length !== 1) throw new Error("usage: preskill scan <path-or-url> [options]");
      args.target = rest[0] ?? "";
    } else {
      if (positional.length !== 1) throw new Error("usage: preskill scan <path-or-url> [options]");
      args.target = command ?? "";
    }
  }
  return args;
}

function helpText(): string {
  return [
    "preskill scan <path-or-url> [options]",
    "",
    "Reads a Skill before an agent installs it. Accepts a local folder, a zip,",
    "a GitHub URL or a raw SKILL.md URL.",
    "",
    "Examples:",
    "  preskill scan ./my-skill",
    "  preskill scan ./my-skill.zip --json",
    "  preskill scan https://github.com/owner/repo/tree/main/skills/my-skill",
    "",
    "Options:",
    "  --provider perplexity|openrouter  Which judge API to call.",
    "  --model <id>                     Override the model. Defaults to the measured model.",
    "  --endpoint <url>                 Override the Decisions endpoint.",
    "  --floor <0..1>                   Flag at or above this probability. Default 0.05.",
    "  --person-request <text>          The person's own words that carried the link.",
    "  --concurrency <n>                Requests in flight per Skill. Default 6.",
    "  --timeout-ms <n>                 One request's deadline. Default 15000.",
    "  --key-env <NAME>                 Read the key from this variable; add --provider if needed.",
    "  --json                           Print the typed result only.",
    "  --help                           Show this text.",
    "",
    "Environment:",
    "  Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY; the provider is inferred.",
    "  PRESKILL_PROVIDER overrides the inferred provider.",
    "  PRESKILL_API_KEY overrides the provider key.",
    "",
    "Exit codes: 0 safe, 1 flagged, 2 refused or error.",
  ].join("\n");
}

function envProvider(): "perplexity" | "openrouter" | undefined {
  const value = process.env.PRESKILL_PROVIDER;
  return value === "perplexity" || value === "openrouter" ? value : undefined;
}

function providerFromKeyEnv(name: string | undefined): "perplexity" | "openrouter" | undefined {
  if (!name) return undefined;
  const normalized = name.toUpperCase();
  if (normalized.includes("OPENROUTER")) return "openrouter";
  if (normalized.includes("PERPLEXITY")) return "perplexity";
  return undefined;
}

function resolveProvider(args: Args): { provider: "perplexity" | "openrouter"; apiKey: string } {
  const custom = args.keyEnv ? process.env[args.keyEnv]?.trim() : undefined;
  if (args.keyEnv && !custom) throw new Error(`environment variable ${args.keyEnv} is empty`);
  const perplexityKey = process.env.PERPLEXITY_API_KEY?.trim();
  const openrouterKey = process.env.OPENROUTER_API_KEY?.trim();
  const provider =
    args.provider ??
    envProvider() ??
    providerFromKeyEnv(args.keyEnv) ??
    (perplexityKey ? "perplexity" : openrouterKey ? "openrouter" : "perplexity");
  const apiKey =
    custom ??
    process.env.PRESKILL_API_KEY?.trim() ??
    (provider === "perplexity" ? perplexityKey : openrouterKey);
  if (!apiKey) {
    throw new Error(
      `No API key. Set ${provider === "perplexity" ? "PERPLEXITY_API_KEY" : "OPENROUTER_API_KEY"} or PRESKILL_API_KEY.`,
    );
  }
  return { provider, apiKey };
}

function human(result: SkillScanResult, target: string): string {
  const lines: string[] = [`preskill: ${target}`, `Verdict: ${result.verdict}`];
  if (result.flaggedQuestions.length > 0) {
    lines.push("", "Flagged questions:");
    for (const id of result.flaggedQuestions) {
      const sentence = result.reasons.questions[id];
      if (sentence) lines.push(`  - ${asSentence(sentence)}`);
      const paths = result.pathsByQuestion[id] ?? [];
      if (paths.length > 0) lines.push(`    Files: ${paths.join(", ")}`);
    }
  }
  if (result.reasons.other.length > 0) {
    lines.push("", "Other findings:");
    for (const sentence of result.reasons.other) lines.push(`  - ${sentence}`);
  }
  if (result.refusals.length > 0) {
    lines.push("", "Refused:");
    for (const entry of result.refusals) lines.push(`  - ${entry.reason}`);
  }
  if (result.verdict === "safe") lines.push("", "No question reached the floor.");
  lines.push("", `Checked with ${result.model}; ${result.requestCount} request(s).`);
  return lines.join("\n");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  const { provider, apiKey } = resolveProvider(args);
  let files: readonly SkillInputFile[];
  let source: SkillSource;
  let missingFiles: readonly { path: string; reason: "not_found" | "unavailable" | "unsafe_path" | "too_large" }[] = [];
  if (/^https:\/\//iu.test(args.target)) {
    const fetched = await fetchSkillFromUrl(args.target);
    files = fetched.files;
    source = fetched.source;
    missingFiles = fetched.missingFiles;
  } else {
    files = await readSkillTarget(args.target);
    source = { link: args.target, catalog: "web", catalog_review: "not_checked" };
  }
  const judge = createHttpJudge({
    apiKey,
    provider,
    ...(args.model ? { model: args.model } : {}),
    ...(args.endpoint ? { endpoint: args.endpoint } : {}),
    ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
  });
  const result = await scanSkill(
    { files, source, missingFiles, ...(args.personRequest ? { personRequest: args.personRequest } : {}) },
    {
      judge,
      ...(args.floor !== undefined ? { floor: args.floor } : {}),
      ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}),
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      ...(args.personRequest ? { personRequest: args.personRequest } : {}),
    },
  );
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${human(result, args.target)}\n`);
  }
  return result.verdict === "safe" ? 0 : result.verdict === "flagged" ? 1 : 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(`preskill: ${message}\n`);
    process.exitCode = 2;
  });
