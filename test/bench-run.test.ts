import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { runBench, benchReadErrorCode } from "../bench/run.js";

const base = {
  set: "govbench" as const,
  provider: "perplexity" as const,
  floors: [0.05],
  confirmSpend: false,
  dryRun: true,
  concurrency: 6,
};

for (const [label, maxCostUsd] of [
  ["NaN", Number.NaN],
  ["negative", -1],
  ["infinite", Number.POSITIVE_INFINITY],
] as const) {
  test(`a ${label} cost cap fails before reading the bench directory`, async () => {
    await assert.rejects(
      () =>
        runBench({
          ...base,
          dir: join(tmpdir(), "preskill-does-not-exist"),
          maxCostUsd,
        }),
      /max_cost_usd_invalid/u,
    );
  });
}

test("bench read errors keep their closed code", () => {
  assert.equal(benchReadErrorCode(new Error("skill_symlink")), "skill_symlink");
  assert.equal(benchReadErrorCode(new Error("skill_source_too_large")), "skill_source_too_large");
  assert.equal(benchReadErrorCode(new Error("ENOENT: no such file")), "skill_source_unreadable");
  assert.equal(benchReadErrorCode("not an error"), "skill_source_unreadable");
});
