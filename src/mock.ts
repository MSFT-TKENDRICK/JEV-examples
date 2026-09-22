/**
 * An offline transport that mimics Jev's response shape.
 *
 * It exists so every example in this repo runs, and can be asserted on, with no
 * API key and no network. It is NOT a model: it returns scripted answers, and
 * falls back to a deterministic hash for anything unscripted.
 *
 * What it does reproduce faithfully is the *contract*, which is the part your
 * code has to be correct against:
 *   - probability distributions sum to 1
 *   - a Score equals the probability-weighted mean of its level indices
 *   - a Choice's selected option is the one with maximal probability
 *   - confidence lives in providerMetadata.typesafe.confidence, not on answers
 *
 * The AI SDK ships an equivalent for real code: `Experimental_EvaluationMockModelV4`
 * from `ai/test`.
 */

import type {
  Answer,
  BooleanAnswer,
  ChoiceAnswer,
  ChoiceQuestion,
  EvaluateRequest,
  RawEvaluationResponse,
  ScoreAnswer,
  ScoreQuestion,
  Transport,
} from './jev.ts';

/** What a script may return per question id: a full answer or a shorthand. */
export type ScriptedAnswer =
  | { choice: string; strength?: number }
  | { score: number; strength?: number }
  | { probability: number }
  | Answer;

export type MockScript = (
  request: EvaluateRequest,
) => Record<string, ScriptedAnswer | undefined> | undefined;

/** Stable 32-bit hash so unscripted answers are deterministic across runs. */
function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Builds a distribution peaked on `targetIndex`.
 * `strength` is the probability mass given to the target; the rest decays with
 * distance so neighbouring levels stay more likely than distant ones.
 */
function peakedDistribution(size: number, targetIndex: number, strength: number): number[] {
  if (size === 1) return [1];
  const clamped = Math.min(Math.max(strength, 1 / size), 0.999);
  const weights = Array.from({ length: size }, (_, i) =>
    i === targetIndex ? 0 : 1 / (1 + Math.abs(i - targetIndex) ** 2),
  );
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const remainder = 1 - clamped;
  const distribution = weights.map((w) =>
    totalWeight === 0 ? remainder / (size - 1) : (w / totalWeight) * remainder,
  );
  distribution[targetIndex] = clamped;
  return distribution;
}

/** Renormalizes after rounding so the contract (sums to 1) still holds exactly. */
function normalizeRounded(values: number[]): number[] {
  const rounded = values.map((v) => round(v));
  const drift = round(1 - rounded.reduce((sum, v) => sum + v, 0));
  if (drift !== 0) {
    let maxIndex = 0;
    for (let i = 1; i < rounded.length; i++) {
      if ((rounded[i] ?? 0) > (rounded[maxIndex] ?? 0)) maxIndex = i;
    }
    rounded[maxIndex] = round((rounded[maxIndex] ?? 0) + drift);
  }
  return rounded;
}

/** Normalized-entropy confidence: 1.0 when all mass sits on one outcome. */
function confidenceFrom(distribution: number[]): number {
  const size = distribution.length;
  if (size <= 1) return 1;
  const entropy = -distribution.reduce(
    (sum, p) => (p > 0 ? sum + p * Math.log(p) : sum),
    0,
  );
  return round(Math.max(0, 1 - entropy / Math.log(size)), 4);
}

function buildChoice(
  question: ChoiceQuestion,
  scripted: ScriptedAnswer | undefined,
  seed: string,
): { answer: ChoiceAnswer; confidence: number } {
  const options = Object.keys(question.criteria);
  if (options.length === 0) throw new Error('Choice question has no options');

  let targetIndex: number;
  let strength: number;

  if (scripted && 'choice' in scripted && typeof scripted.choice === 'string') {
    const index = options.indexOf(scripted.choice);
    if (index === -1) {
      throw new Error(`Mock script chose "${scripted.choice}", which is not an option`);
    }
    targetIndex = index;
    strength = ('strength' in scripted ? scripted.strength : undefined) ?? 0.88;
  } else {
    targetIndex = Math.floor(hash(seed) * options.length) % options.length;
    strength = 0.45 + hash(`${seed}:strength`) * 0.5;
  }

  const distribution = normalizeRounded(peakedDistribution(options.length, targetIndex, strength));
  const probabilities: Record<string, number> = {};
  options.forEach((option, index) => {
    probabilities[option] = distribution[index] ?? 0;
  });

  // The selected option must be the one with maximal probability.
  let bestOption = options[0] as string;
  for (const option of options) {
    if ((probabilities[option] ?? 0) > (probabilities[bestOption] ?? 0)) bestOption = option;
  }

  return {
    answer: { type: 'choice', choice: bestOption, probabilities },
    confidence: confidenceFrom(distribution),
  };
}

function buildScore(
  question: ScoreQuestion,
  scripted: ScriptedAnswer | undefined,
  seed: string,
): { answer: ScoreAnswer; confidence: number } {
  const levels = question.criteria.length;
  if (levels < 2) throw new Error('Score question needs at least 2 levels');

  let target: number;
  let strength: number;

  if (scripted && 'score' in scripted && typeof scripted.score === 'number') {
    target = Math.min(Math.max(scripted.score, 0), levels - 1);
    strength = ('strength' in scripted ? scripted.strength : undefined) ?? 0.8;
  } else {
    target = hash(seed) * (levels - 1);
    strength = 0.5 + hash(`${seed}:strength`) * 0.4;
  }

  // A Score is the probability-weighted mean of its level indices, so the
  // distribution has to be solved for rather than guessed at. Hold a background
  // "spread" fixed, then place the remaining mass on the two levels bracketing
  // the target so the mean comes out exactly right.
  const lower = Math.min(Math.floor(target), levels - 2);
  const upper = lower + 1;

  const spread = peakedDistribution(levels, Math.round(target), 1 / levels);
  const spreadMean = spread.reduce((sum, p, index) => sum + p * index, 0);

  // mean = (1 - s) * spreadMean + a * lower + b * upper, with a + b = s
  //     => a = (1 - s) * spreadMean + s * upper - target
  let s = Math.min(Math.max(strength, 0.05), 0.95);
  let a = (1 - s) * spreadMean + s * upper - target;

  // If the target sits outside what this `s` can express, raise `s` until it
  // fits rather than clamping and silently missing the requested score.
  if (a < 0 && upper !== spreadMean) {
    s = Math.min(Math.max((target - spreadMean) / (upper - spreadMean), s), 0.999);
    a = 0;
  } else if (a > s && spreadMean !== lower) {
    s = Math.min(Math.max((spreadMean - target) / (spreadMean - lower), s), 0.999);
    a = s;
  }
  a = Math.min(Math.max(a, 0), s);
  const b = s - a;

  const base = spread.map((p) => p * (1 - s));
  base[lower] = (base[lower] ?? 0) + a;
  base[upper] = (base[upper] ?? 0) + b;

  const distribution = normalizeRounded(base);
  const probabilities: Record<string, number> = {};
  distribution.forEach((p, index) => {
    probabilities[String(index)] = p;
  });

  // A Score is the probability-weighted mean of its level indices, by definition.
  const score = round(distribution.reduce((sum, p, index) => sum + p * index, 0));

  return {
    answer: { type: 'score', score, probabilities },
    confidence: confidenceFrom(distribution),
  };
}

function buildBoolean(scripted: ScriptedAnswer | undefined, seed: string): BooleanAnswer {
  const probability =
    scripted && 'probability' in scripted && typeof scripted.probability === 'number'
      ? scripted.probability
      : round(hash(seed));
  return { type: 'boolean', probability: round(Math.min(Math.max(probability, 0), 1)) };
}

export interface MockOptions {
  script?: MockScript;
  /** Simulated round-trip latency. Jev's real p50 is in the low hundreds of ms. */
  latencyMs?: number;
}

/**
 * Creates a transport that answers without a network call.
 *
 * ```ts
 * const transport = createMockTransport({
 *   script: () => ({ requestsRefund: { probability: 0.96 } }),
 * });
 * ```
 */
export function createMockTransport(options: MockOptions = {}): Transport {
  const { script, latencyMs = 0 } = options;

  return async (request: EvaluateRequest): Promise<{ body: RawEvaluationResponse }> => {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));

    const scripted = script?.(request) ?? {};
    const answers: Record<string, Answer> = {};
    const confidence: Record<string, number> = {};

    for (const [id, question] of Object.entries(request.questions)) {
      const seed = `${id}:${JSON.stringify(request.state)}`;
      const entry = scripted[id];

      // A fully-formed answer passes straight through.
      if (entry && 'type' in entry) {
        answers[id] = entry;
        continue;
      }

      if (question.type === 'choice') {
        const built = buildChoice(question, entry, seed);
        answers[id] = built.answer;
        confidence[id] = built.confidence;
      } else if (question.type === 'score') {
        const built = buildScore(question, entry, seed);
        answers[id] = built.answer;
        confidence[id] = built.confidence;
      } else {
        answers[id] = buildBoolean(entry, seed);
      }
    }

    const inputTokens = Math.ceil(JSON.stringify(request).length / 4);

    return {
      body: {
        answers,
        usage: { inputTokens, outputTokens: Object.keys(answers).length * 18 },
        warnings: [],
        rounding: { probabilityDecimals: 4, scoreDecimals: 4 },
        providerMetadata: { typesafe: { confidence } },
      },
    };
  };
}

/**
 * Picks the transport for an example: the real Gateway when a key is present,
 * the mock otherwise. Set JEV_MOCK=1 to force the mock.
 */
export function transportForExample(script?: MockScript): {
  transport: Transport | undefined;
  live: boolean;
} {
  const forceMock = process.env.JEV_MOCK === '1';
  const hasKey = Boolean(process.env.AI_GATEWAY_API_KEY);

  if (!forceMock && hasKey) return { transport: undefined, live: true };
  return {
    transport: createMockTransport({ ...(script && { script }), latencyMs: 40 }),
    live: false,
  };
}
