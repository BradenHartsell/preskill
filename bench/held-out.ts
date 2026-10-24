/**
 * Held-out runner. It never contains a held-out Skill, never downloads one,
 * and never tunes anything. Point it at your own labelled copy:
 *
 *   npx tsx bench/held-out.ts --dir <dir> --confirm-spend [--json]
 *
 * A held-out set is run once per final question set. Re-running it after
 * changing a question or a floor turns it into a tuning set.
 */

import { resolve } from "node:path";
import { runBench } from "./run.js";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(
    "bench/held-out.ts --dir <dir> --confirm-spend [--provider perplexity|openrouter] [--json]\n",
  );
} else {
  if (argv.includes("--tune")) throw new Error("a held-out set is never used for tuning");
  const index = argv.indexOf("--dir");
  const dir = index >= 0 ? argv[index + 1] : undefined;
  if (!dir) throw new Error("usage: bench/held-out.ts --dir <labelled directory> --confirm-spend");
  const provider = argv.includes("--provider")
    ? (argv[argv.indexOf("--provider") + 1] as "perplexity" | "openrouter")
    : process.env.PRESKILL_PROVIDER === "openrouter"
      ? "openrouter"
      : "perplexity";
  const apiKey =
    process.env.PRESKILL_API_KEY ??
    (provider === "openrouter" ? process.env.OPENROUTER_API_KEY : process.env.PERPLEXITY_API_KEY);
  const maxCostUsd = Number(process.env.PRESKILL_BENCH_MAX_COST_USD ?? "1");
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) throw new Error("max_cost_usd_invalid");
  const aggregate = await runBench({
    set: "held-out",
    dir: resolve(dir),
    heldOut: true,
    provider,
    ...(apiKey ? { apiKey } : {}),
    floors: [0.05, 0.1, 0.2],
    maxCostUsd,
    confirmSpend: argv.includes("--confirm-spend"),
    dryRun: argv.includes("--dry-run"),
    concurrency: 6,
  });
  process.stdout.write(argv.includes("--json") ? `${JSON.stringify(aggregate, null, 2)}\n` : `${JSON.stringify(aggregate, null, 2)}\n`);
}
