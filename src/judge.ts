/**
 * Provider facts checked 2026-10-24:
 *
 * Perplexity:
 * - Decisions endpoint: POST https://api.perplexity.ai/v1/decisions
 *   https://docs.perplexity.ai/docs/decisions
 * - Model ids: `pplx-decider-v1.2` and `pplx-decider-flash-v1.2` (aliases
 *   `pplx-decider-latest` / `pplx-decider-flash-latest`).
 * - Request `{ model, state, questions }`; response `{ model, answers, usage }`
 *   with `answers[id].noul` for a Noul and `usage.input_tokens` /
 *   `usage.output_tokens` (no `cost` field in the Perplexity response).
 * - Price: $0.02 per million input tokens for `pplx-decider-v1.2`; output free.
 *
 * OpenRouter:
 * - Decisions endpoint: `POST https://openrouter.ai/api/alpha/decisions`
 *   https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request
 *   (System One at `/api/v1/systemone` is the other surface; the package uses
 *   the plain Decisions endpoint.)
 * - Model id: `perplexity/pplx-decider-v1.2`; the provider snapshot is
 *   `perplexity/pplx-decider-v1.2-20261016`. Price checked from
 *   https://openrouter.ai/api/v1/models/perplexity/pplx-decider-v1.2/endpoints:
 *   `prompt: 0.00000002` USD per token, `completion: 0`.
 * - The request schema includes `provider: ProviderPreferences`, and
 *   `ProviderPreferences.data_collection` accepts `"deny"`, `"allow"` or
 *   `null`. `provider.data_collection: "deny"` is therefore valid on this
 *   endpoint (the docs also describe it as routing only to providers that do
 *   not collect user data). The response includes `model`, `answers`, and
 *   `usage` with optional `cost`, plus `input_tokens` and `output_tokens`.
 *
 * The request and response shapes below follow those docs.
 */

import { skillSafetyQuestions, type NoulQuestion } from "./questions.js";
import type { QuestionId, SkillSafetyState } from "./types.js";
import { questionIds } from "./types.js";

export type JudgeProvider = "perplexity" | "openrouter" | "custom";

export interface JudgeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
}

export interface JudgeResult {
  /** The model the provider reported. */
  readonly model: string;
  readonly answers: Readonly<Record<QuestionId, number>>;
  readonly usage: JudgeUsage;
  readonly latencyMs: number;
}

export interface JudgeOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /**
   * The questions to ask. `scanSkill` passes the selected ruleset's questions;
   * when absent, a judge asks the default (v1) questions. A custom judge that
   * builds its own request should send these.
   */
  readonly questions?: Readonly<Record<QuestionId, NoulQuestion>>;
}

export interface Judge {
  /** The model this judge will ask. */
  readonly model: string;
  readonly provider: JudgeProvider;
  judge(state: SkillSafetyState, options?: JudgeOptions): Promise<JudgeResult>;
}

export type JudgeFailureKind =
  | "request_invalid"
  | "response_invalid"
  | "unauthorized"
  | "payment_required"
  | "rate_limited"
  | "provider_unavailable"
  | "request_rejected"
  | "timeout"
  | "aborted";

export class JudgeError extends Error {
  constructor(
    readonly kind: JudgeFailureKind,
    readonly status?: number,
  ) {
    super(`judge_${kind}`);
    this.name = "JudgeError";
  }
}

export const defaultModels: Readonly<Record<"perplexity" | "openrouter", string>> = {
  perplexity: "pplx-decider-v1.2",
  openrouter: "perplexity/pplx-decider-v1.2",
};

/** Published list price, USD per input token, for the measured model. Output is free. */
export const measuredModelInputPriceUsd = 0.00000002;

export const defaultEndpoints: Readonly<Record<"perplexity" | "openrouter", string>> = {
  perplexity: "https://api.perplexity.ai/v1/decisions",
  openrouter: "https://openrouter.ai/api/alpha/decisions",
};

export interface HttpJudgeOptions {
  readonly apiKey: string;
  readonly provider?: "perplexity" | "openrouter";
  readonly model?: string;
  /** A full endpoint. Defaults to the provider's documented Decisions endpoint. */
  readonly endpoint?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

interface RequestBody {
  model: string;
  state: SkillSafetyState;
  questions: Readonly<Record<QuestionId, NoulQuestion>>;
  provider?: { data_collection: "deny" };
}

function requestBody(
  provider: "perplexity" | "openrouter",
  model: string,
  state: SkillSafetyState,
  questions: Readonly<Record<QuestionId, NoulQuestion>>,
): RequestBody {
  const body: RequestBody = { model, state, questions };
  // OpenRouter documents this preference; Perplexity's Decisions API rejects
  // unknown top-level fields, so it is only sent to OpenRouter.
  if (provider === "openrouter") body.provider = { data_collection: "deny" };
  return body;
}

function parseAnswers(body: unknown): { model: string; answers: Record<QuestionId, number>; usage: JudgeUsage } {
  if (!body || typeof body !== "object") throw new JudgeError("response_invalid");
  const record = body as Record<string, unknown>;
  if (typeof record.model !== "string" || !record.model.trim()) throw new JudgeError("response_invalid");
  const rawAnswers = record.answers;
  if (!rawAnswers || typeof rawAnswers !== "object") throw new JudgeError("response_invalid");
  const answerRecord = rawAnswers as Record<string, unknown>;
  // Every ruleset asks the same seven ids.
  const ids: readonly QuestionId[] = questionIds;
  if (Object.keys(answerRecord).length !== ids.length || !ids.every((id) => Object.hasOwn(answerRecord, id))) {
    throw new JudgeError("response_invalid");
  }
  const answers = {} as Record<QuestionId, number>;
  for (const id of ids) {
    const answer = answerRecord[id];
    if (!answer || typeof answer !== "object") throw new JudgeError("response_invalid");
    const value = answer as Record<string, unknown>;
    if (value.type !== "noul" || typeof value.noul !== "number" || !Number.isFinite(value.noul) || value.noul < 0 || value.noul > 1) {
      throw new JudgeError("response_invalid");
    }
    answers[id] = value.noul;
  }
  const rawUsage = record.usage;
  if (!rawUsage || typeof rawUsage !== "object") throw new JudgeError("response_invalid");
  const usage = rawUsage as Record<string, unknown>;
  if (
    typeof usage.input_tokens !== "number" ||
    !Number.isFinite(usage.input_tokens) ||
    usage.input_tokens < 0 ||
    typeof usage.output_tokens !== "number" ||
    !Number.isFinite(usage.output_tokens) ||
    usage.output_tokens < 0
  ) {
    throw new JudgeError("response_invalid");
  }
  return {
    model: record.model,
    answers,
    usage: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      ...(typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
        ? { costUsd: usage.cost }
        : {}),
    },
  };
}

/**
 * A judge that calls the user's own Perplexity or OpenRouter key. One request
 * per state, no retry, no fallback.
 */
export function createHttpJudge(options: HttpJudgeOptions): Judge {
  const provider = options.provider ?? "perplexity";
  const model = options.model ?? defaultModels[provider];
  const endpoint = options.endpoint ?? defaultEndpoints[provider];
  const fetcher = options.fetch ?? fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("judge_api_key_missing");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("judge_timeout_invalid");
  return {
    model,
    provider,
    async judge(state, judgeOptions = {}) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), judgeOptions.timeoutMs ?? timeoutMs);
      const forwardAbort = (): void => controller.abort();
      if (judgeOptions.signal) {
        if (judgeOptions.signal.aborted) {
          clearTimeout(timer);
          throw new JudgeError("aborted");
        }
        judgeOptions.signal.addEventListener("abort", forwardAbort, { once: true });
      }
      let response: Response;
      try {
        response = await fetcher(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(requestBody(provider, model, state, judgeOptions.questions ?? skillSafetyQuestions)),
          signal: controller.signal,
        });
      } catch (error) {
        if (judgeOptions.signal?.aborted) throw new JudgeError("aborted");
        if (controller.signal.aborted) throw new JudgeError("timeout");
        throw new JudgeError("provider_unavailable");
      } finally {
        clearTimeout(timer);
        judgeOptions.signal?.removeEventListener("abort", forwardAbort);
      }
      if (response.status !== 200) {
        // The error body can quote the request, so it is never read.
        await response.body?.cancel().catch(() => undefined);
        const status = response.status;
        throw new JudgeError(
          status === 401 || status === 403
            ? "unauthorized"
            : status === 402
              ? "payment_required"
              : status === 429
                ? "rate_limited"
                : status >= 500 || status === 408
                  ? "provider_unavailable"
                  : "request_rejected",
          status,
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(await response.text());
      } catch {
        throw new JudgeError("response_invalid", response.status);
      }
      const parsed = parseAnswers(body);
      const costUsd =
        parsed.usage.costUsd ??
        (model === defaultModels.perplexity || model === defaultModels.openrouter
          ? parsed.usage.inputTokens * measuredModelInputPriceUsd
          : undefined);
      return {
        model: parsed.model,
        answers: parsed.answers,
        usage: {
          inputTokens: parsed.usage.inputTokens,
          outputTokens: parsed.usage.outputTokens,
          ...(costUsd === undefined ? {} : { costUsd }),
        },
        latencyMs: Date.now() - started,
      };
    },
  };
}

/** A judge a test can supply without any network. */
export function createStaticJudge(
  model: string,
  handler: (state: SkillSafetyState, call: number) => Promise<JudgeResult> | JudgeResult,
): Judge {
  let call = 0;
  return {
    model,
    provider: "custom",
    async judge(state) {
      call += 1;
      return handler(state, call);
    },
  };
}
