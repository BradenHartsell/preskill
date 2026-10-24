import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { questionIds } from "../src/types.js";
import { skillMd } from "./helpers.js";

const run = promisify(execFile);

function cli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
  });
}

test("the CLI documents the scan command", async () => {
  const { stdout } = await cli(["--help"]);
  assert.match(stdout, /^preskill scan <path-or-url>/mu);
  assert.match(stdout, /preskill scan \.\/my-skill/u);
});

test("the scan command requires a target", async () => {
  await assert.rejects(
    () => cli(["scan"]),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      return failure.code === 2 && /usage: preskill scan/u.test(failure.stderr ?? "");
    },
  );
});

test("--key-env takes the provider from the variable name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preskill-cli-"));
  let requestBody = "";
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requestBody = body;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "mock-decider",
          answers: Object.fromEntries(
            questionIds.map((id) => [id, { type: "noul", noul: 0 }]),
          ),
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
      );
    });
  });
  try {
    await writeFile(join(dir, "SKILL.md"), skillMd("test-skill", "A test skill."));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server port");
    const { stdout } = await cli(
      [
        "scan",
        dir,
        "--key-env",
        "OPENROUTER_API_KEY",
        "--endpoint",
        `http://127.0.0.1:${address.port}/v1/decisions`,
        "--json",
      ],
      { OPENROUTER_API_KEY: "mock", PRESKILL_PROVIDER: "" },
    );
    assert.equal((JSON.parse(stdout) as { verdict: string }).verdict, "safe");
    assert.match(requestBody, /"provider":\{"data_collection":"deny"\}/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
