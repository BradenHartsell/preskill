import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { questionIds } from "../src/types.js";
import { questionSetVersion, questionSetVersionV2 } from "../src/version.js";
import { skillMd } from "./helpers.js";

const run = promisify(execFile);

function cli(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, PRESKILL_RULESET: "", ...env },
  });
}

/** Scans one synthetic Skill against a local mock judge and returns the result and the request body it got. */
async function scanWithMock(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ result: { verdict: string; questionSetVersion: string }; body: string; stdout: string }> {
  const dir = await mkdtemp(join(tmpdir(), "preskill-ruleset-"));
  let body = "";
  const server = createServer((request, response) => {
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "mock-decider",
          answers: Object.fromEntries(questionIds.map((id) => [id, { type: "noul", noul: 0 }])),
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
      );
    });
  });
  try {
    await writeFile(join(dir, "SKILL.md"), skillMd("ruleset-skill", "A test skill."));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server port");
    const { stdout } = await cli(
      ["scan", dir, "--provider", "perplexity", "--endpoint", `http://127.0.0.1:${address.port}/v1/decisions`, ...args],
      { PERPLEXITY_API_KEY: "mock", PRESKILL_PROVIDER: "", ...env },
    );
    const result = args.includes("--json")
      ? (JSON.parse(stdout) as { verdict: string; questionSetVersion: string })
      : { verdict: "", questionSetVersion: "" };
    return { result, body, stdout };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

test("the help text documents --ruleset and PRESKILL_RULESET", async () => {
  const { stdout } = await cli(["--help"]);
  assert.match(stdout, /--ruleset v1\|v2/u);
  assert.match(stdout, /PRESKILL_RULESET=v2/u);
});

test("an unknown --ruleset is an error", async () => {
  await assert.rejects(
    () => cli(["scan", "./nowhere", "--ruleset", "v3"]),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      return failure.code === 2 && /ruleset_must_be_v1_or_v2/u.test(failure.stderr ?? "");
    },
  );
});

test("an unknown PRESKILL_RULESET is an error, not a silent default", async () => {
  await assert.rejects(
    () => cli(["scan", "./nowhere"], { PRESKILL_RULESET: "latest", PERPLEXITY_API_KEY: "mock" }),
    (error: unknown) => /ruleset_must_be_v1_or_v2/u.test((error as { stderr?: string }).stderr ?? ""),
  );
});

test("by default the CLI sends the v1 questions", async () => {
  const { result, body } = await scanWithMock(["--json"], {});
  assert.equal(result.questionSetVersion, questionSetVersion);
  assert.match(body, /catalog_review/u);
  assert.doesNotMatch(body, /persona-like/u);
});

test("--ruleset v2 and PRESKILL_RULESET=v2 send the v2 questions; --ruleset wins over the variable", async () => {
  const flag = await scanWithMock(["--json", "--ruleset", "v2"], {});
  assert.equal(flag.result.questionSetVersion, questionSetVersionV2);
  assert.match(flag.body, /persona-like/u);
  assert.doesNotMatch(flag.body, /catalog_review/u);

  const env = await scanWithMock(["--json"], { PRESKILL_RULESET: "v2" });
  assert.equal(env.result.questionSetVersion, questionSetVersionV2);

  const override = await scanWithMock(["--json", "--ruleset", "v1"], { PRESKILL_RULESET: "v2" });
  assert.equal(override.result.questionSetVersion, questionSetVersion);
});

test("the human output names a non-default ruleset and stays unchanged for v1", async () => {
  const v2 = await scanWithMock(["--ruleset", "v2"], {});
  assert.match(v2.stdout, new RegExp(`Ruleset v2 \\(${questionSetVersionV2}\\)`, "u"));
  const v1 = await scanWithMock([], {});
  assert.doesNotMatch(v1.stdout, /Ruleset/u);
});
