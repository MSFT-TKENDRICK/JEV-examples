/**
 * A tiny, dependency-free Jev client for the Vercel AI Gateway.
 *
 * Why this file exists: `experimental_evaluate` from the `ai` package is the
 * official way to call Jev, but at the time of writing it ships in `vercel/ai`
 * on `main` and is not yet in a published `ai` release. This client speaks the
 * exact same wire protocol as `@ai-sdk/gateway`'s evaluation model, so the
 * examples run today and the migration later is a straight swap.
 *
 * Wire protocol (from packages/gateway/src/gateway-evaluation-model.ts):
 *   POST {baseURL}/evaluation-model
 *   Authorization: Bearer $AI_GATEWAY_API_KEY
 *   ai-evaluation-model-specification-version: 4
 *   ai-model-id: typesafe-ai/jev
 *   body: { state, questions, providerOptions? }
 *
 * See docs/PROTOCOL.md for the full mapping to `experimental_evaluate`.
 */

export const GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v4/ai';
export const JEV_MODEL_ID = 'typesafe-ai/jev';

/** JSON-compatible value. Jev rejects functions, cycles and non-finite numbers. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Instructions and criteria may be a string, or structured JSON when you want to
 * separate the question from the data it refers to.
 */
export type Description = string | Json[] | { [key: string]: Json } | null;

export interface ChoiceQuestion {
  type: 'choice';
  instructions: Description;
  /** Option key -> description. `null` means "no extra detail". Max 255 options. */
  criteria: Record<string, Description>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: Description;
  /** Ordered level descriptions, lowest first. At least 2, at most 10. */
  criteria: readonly Description[];
}

export interface BooleanQuestion {
  type: 'boolean';
  instructions: Description;
  /** Optional clarification of what true and false mean. */
  criteria?: { true?: Description; false?: Description };
}

export type Question = ChoiceQuestion | ScoreQuestion | BooleanQuestion;
export type QuestionMap = Record<string, Question>;

export interface ChoiceAnswer<Option extends string = string> {
  type: 'choice';
  /** The highest-probability option. */
  choice: Option;
  /** Optional in the spec; Jev always returns it. */
  probabilities?: Record<Option, number>;
}

export interface ScoreAnswer {
  type: 'score';
  /** Probability-weighted position in [0, levels - 1]. Can land between levels. */
  score: number;
  /** Optional: zero-based level index (as a string key) -> probability. */
  probabilities?: Record<string, number>;
}

export interface BooleanAnswer {
  type: 'boolean';
  /**
   * The model's probability that the statement is true.
   * This is NOT confidence: 0.5 means genuinely undecided, not "medium".
   */
  probability: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | BooleanAnswer;

/** Extracts the literal option keys from a Choice question, so `answer.choice` is a union. */
type ChoiceOptionsOf<Q> = Q extends { type: 'choice'; criteria: infer C }
  ? Extract<keyof C, string>
  : string;

export type AnswerFor<Q> = Q extends { type: 'choice' }
  ? ChoiceAnswer<ChoiceOptionsOf<Q>>
  : Q extends { type: 'score' }
    ? ScoreAnswer
    : Q extends { type: 'boolean' }
      ? BooleanAnswer
      : never;

export type AnswersFor<Q extends QuestionMap> = { [K in keyof Q]: AnswerFor<Q[K]> };

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type Warning =
  | { type: 'unsupported'; feature: string; details?: string }
  | { type: 'compatibility'; feature: string; details?: string }
  | { type: 'deprecated'; setting: string; message: string }
  | { type: 'other'; message: string };

export interface ProviderMetadata {
  /** TypeSafe reports per-question Choice/Score confidence here, keyed by question id. */
  typesafe?: { confidence?: Record<string, number> };
  [provider: string]: Record<string, unknown> | undefined;
}

export interface EvaluationResult<Q extends QuestionMap> {
  answers: AnswersFor<Q>;
  usage?: Usage;
  warnings: Warning[];
  /** Declared decimal precision, when the provider rounds its output. */
  rounding?: { probabilityDecimals?: number; scoreDecimals?: number };
  providerMetadata?: ProviderMetadata;
  response: { modelId: string; headers?: Record<string, string>; body?: unknown };
}

/** The raw body returned by the Gateway, before typing. */
export interface RawEvaluationResponse {
  answers: Record<string, Answer>;
  usage?: { inputTokens?: number; outputTokens?: number };
  warnings?: Warning[];
  rounding?: { probabilityDecimals?: number; scoreDecimals?: number };
  providerMetadata?: ProviderMetadata;
}

export interface EvaluateRequest {
  state: Json;
  questions: QuestionMap;
  modelId: string;
  providerOptions?: Record<string, Json>;
}

/** Swap this out to run offline. See src/mock.ts. */
export type Transport = (
  request: EvaluateRequest,
  init: { signal?: AbortSignal },
) => Promise<{ body: RawEvaluationResponse; headers?: Record<string, string> }>;

export interface EvaluateOptions<Q extends QuestionMap> {
  /** Shared state every question is evaluated against. One state, not a batch. */
  state: Json;
  /** Non-empty map of typed questions. Evaluated in parallel, in isolation. */
  questions: Q;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  abortSignal?: AbortSignal;
  /** Retries on 429 / 5xx with exponential backoff. Defaults to 2. */
  maxRetries?: number;
  providerOptions?: Record<string, Json>;
  transport?: Transport;
}

export class JevError extends Error {
  readonly status?: number;
  readonly body?: unknown;
  constructor(message: string, options: { status?: number; body?: unknown; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'JevError';
    this.status = options.status;
    this.body = options.body;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createGatewayTransport(options: {
  apiKey: string;
  baseURL: string;
  headers?: Record<string, string>;
  maxRetries: number;
}): Transport {
  return async (request, init) => {
    const url = `${options.baseURL.replace(/\/$/, '')}/evaluation-model`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
      if (attempt > 0) await sleep(2 ** (attempt - 1) * 500);

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
            // Identifies the evaluation spec version and the target model.
            'ai-evaluation-model-specification-version': '4',
            'ai-model-id': request.modelId,
            ...options.headers,
          },
          body: JSON.stringify({
            state: request.state,
            questions: request.questions,
            ...(request.providerOptions ? { providerOptions: request.providerOptions } : {}),
          }),
          signal: init.signal ?? null,
        });
      } catch (cause) {
        if (init.signal?.aborted) throw cause;
        lastError = new JevError(`Network error calling the AI Gateway: ${String(cause)}`, { cause });
        continue;
      }

      if (!response.ok) {
        const text = await response.text();
        const error = new JevError(
          `AI Gateway returned ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
          { status: response.status, body: text },
        );
        if (RETRYABLE_STATUS.has(response.status) && attempt < options.maxRetries) {
          lastError = error;
          continue;
        }
        throw error;
      }

      const body = (await response.json()) as RawEvaluationResponse;
      return { body, headers: Object.fromEntries(response.headers.entries()) };
    }

    throw lastError instanceof Error
      ? lastError
      : new JevError('Exhausted retries calling the AI Gateway');
  };
}

/** Rejects malformed answers rather than silently normalizing them. */
function validate(questions: QuestionMap, answers: Record<string, Answer>): void {
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (!answer) throw new JevError(`Missing answer for question "${id}"`);
    if (answer.type !== question.type) {
      throw new JevError(
        `Answer type mismatch for "${id}": asked "${question.type}", received "${answer.type}"`,
      );
    }
    if (answer.type === 'boolean' && !Number.isFinite(answer.probability)) {
      throw new JevError(`Non-finite probability for boolean question "${id}"`);
    }
    if (answer.type === 'choice' && !(answer.choice in (question as ChoiceQuestion).criteria)) {
      throw new JevError(
        `Answer for "${id}" chose "${answer.choice}", which is not one of its options`,
      );
    }
    if (answer.type === 'score') {
      const max = (question as ScoreQuestion).criteria.length - 1;
      if (answer.score < 0 || answer.score > max) {
        throw new JevError(`Score for "${id}" is ${answer.score}, outside [0, ${max}]`);
      }
    }
  }
}

/**
 * Evaluates a map of typed questions against one shared state.
 *
 * Every question sees the same state, is evaluated independently and in
 * parallel, and returns an answer under the id you chose. Adding questions
 * barely changes latency, so ask everything you might need in one call.
 */
export async function evaluate<const Q extends QuestionMap>(
  options: EvaluateOptions<Q>,
): Promise<EvaluationResult<Q>> {
  const {
    state,
    questions,
    model = process.env.JEV_MODEL ?? JEV_MODEL_ID,
    baseURL = process.env.JEV_BASE_URL ?? GATEWAY_BASE_URL,
    apiKey = process.env.AI_GATEWAY_API_KEY,
    maxRetries = 2,
  } = options;

  if (Object.keys(questions).length === 0) {
    throw new JevError('`questions` must contain at least one question');
  }

  let transport = options.transport;
  if (!transport) {
    if (!apiKey) {
      throw new JevError(
        'No AI_GATEWAY_API_KEY set and no transport supplied. ' +
          'Copy .env.example to .env and add a key, or pass the mock transport.',
      );
    }
    transport = createGatewayTransport({
      apiKey,
      baseURL,
      maxRetries,
      ...(options.headers && { headers: options.headers }),
    });
  }

  const { body, headers } = await transport(
    {
      state,
      questions,
      modelId: model,
      ...(options.providerOptions && { providerOptions: options.providerOptions }),
    },
    { ...(options.abortSignal && { signal: options.abortSignal }) },
  );

  validate(questions, body.answers);

  const inputTokens = body.usage?.inputTokens;
  const outputTokens = body.usage?.outputTokens;

  return {
    answers: body.answers as AnswersFor<Q>,
    ...(body.usage && {
      usage: {
        ...(inputTokens !== undefined && { inputTokens }),
        ...(outputTokens !== undefined && { outputTokens }),
        ...(inputTokens !== undefined &&
          outputTokens !== undefined && { totalTokens: inputTokens + outputTokens }),
      },
    }),
    warnings: body.warnings ?? [],
    ...(body.rounding && { rounding: body.rounding }),
    ...(body.providerMetadata && { providerMetadata: body.providerMetadata }),
    response: { modelId: model, ...(headers && { headers }), body },
  };
}

/**
 * TypeSafe's Choice/Score confidence statistic, keyed by question id.
 *
 * Confidence measures how concentrated the probability distribution is, which
 * is a different question from "is this answer correct". It is not exposed on
 * the answer itself; it lives in provider metadata.
 */
export function confidenceOf<Q extends QuestionMap>(
  result: EvaluationResult<Q>,
  questionId: keyof Q & string,
): number | undefined {
  return result.providerMetadata?.typesafe?.confidence?.[questionId];
}
