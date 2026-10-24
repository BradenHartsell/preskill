import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpJudge, JudgeError } from "../src/judge.js";
import { questionIds, type SkillSafetyState } from "../src/types.js";

const state: SkillSafetyState = {
  person_request: "add it",
  source: { link: "https://example.test/skill", catalog: "web", catalog_review: "not_checked" },
  skill: { name: "test", description: "A test", instructions: "Body" },
  files: [],
  documents: [],
};

function answerBody(model: string): string {
  return JSON.stringify({
    model,
    answers: Object.fromEntries(questionIds.map((id) => [id, { type: "noul", noul: 0.1 }])),
    usage: { input_tokens: 1_000_000, output_tokens: 7 },
  });
}

test("the Perplexity request uses the documented endpoint and shape", async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const judge = createHttpJudge({
    apiKey: " test-key\n",
    provider: "perplexity",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), ...(init ? { init } : {}) };
      return new Response(answerBody("pplx-decider-v1.2"), { status: 200 });
    }) as typeof fetch,
  });
  const result = await judge.judge(state);
  assert.equal(captured?.url, "https://api.perplexity.ai/v1/decisions");
  const body = JSON.parse(String(captured?.init?.body)) as Record<string, unknown>;
  assert.equal(body.model, "pplx-decider-v1.2");
  assert.equal("provider" in body, false);
  assert.equal((captured?.init?.headers as Record<string, string>).authorization, "Bearer test-key");
  assert.equal(result.answers.takes_person_data_elsewhere, 0.1);
  assert.equal(result.usage.inputTokens, 1_000_000);
  assert.equal(result.usage.costUsd, 0.02);
});

test("the OpenRouter request adds the provider data-collection denial", async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const judge = createHttpJudge({
    apiKey: "test-key",
    provider: "openrouter",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), ...(init ? { init } : {}) };
      return new Response(answerBody("perplexity/pplx-decider-v1.2"), { status: 200 });
    }) as typeof fetch,
  });
  await judge.judge(state);
  assert.equal(captured?.url, "https://openrouter.ai/api/alpha/decisions");
  const body = JSON.parse(String(captured?.init?.body)) as Record<string, unknown>;
  assert.equal(body.model, "perplexity/pplx-decider-v1.2");
  assert.deepEqual(body.provider, { data_collection: "deny" });
});

test("an authorization failure is a typed error and the body is not surfaced", async () => {
  const judge = createHttpJudge({
    apiKey: "bad",
    provider: "perplexity",
    fetch: (async () => new Response('{"error":{"message":"secret detail"}}', { status: 401 })) as typeof fetch,
  });
  await assert.rejects(
    () => judge.judge(state),
    (error: unknown) => error instanceof JudgeError && error.kind === "unauthorized" && !error.message.includes("secret detail"),
  );
});

test("an answer that does not fit the question set is rejected", async () => {
  const judge = createHttpJudge({
    apiKey: "test-key",
    provider: "perplexity",
    fetch: (async () =>
      new Response(JSON.stringify({ model: "x", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
      })) as typeof fetch,
  });
  await assert.rejects(
    () => judge.judge(state),
    (error: unknown) => error instanceof JudgeError && error.kind === "response_invalid",
  );
});

test("a model override is sent as the model and reported back", async () => {
  let captured: RequestInit | undefined;
  const judge = createHttpJudge({
    apiKey: "test-key",
    provider: "perplexity",
    model: "pplx-decider-latest",
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init;
      return new Response(answerBody("pplx-decider-latest"), { status: 200 });
    }) as typeof fetch,
  });
  const result = await judge.judge(state);
  assert.equal((JSON.parse(String(captured?.body)) as Record<string, unknown>).model, "pplx-decider-latest");
  assert.equal(result.model, "pplx-decider-latest");
  assert.equal(result.usage.costUsd, undefined);
});
