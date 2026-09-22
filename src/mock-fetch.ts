/**
 * An offline `Fetch` for the TypeSafe SDK.
 *
 * `TypeSafeClient` takes a `fetch` option, so the examples in this repo run
 * without an API key by swapping the transport rather than the client. Every
 * other layer — request building, retries, timeouts, error classes, response
 * typing — is the real SDK on the real code path.
 *
 * This file only manufactures plausible response bodies. It is deliberately the
 * only place in the repo that knows the wire format.
 */

import type {
  ChoiceQuestion,
  EntryType,
  Fetch,
  Questions,
  ScoreQuestion,
} from '@typesafe-ai/sdk';

/** Shorthand a script may return per question name. */
export type ScriptedAnswer =
  | { choice: string; strength?: number }
  | { distribution: Record<string, number> }
  | { score: number; strength?: number }
  | { noul: number };

export interface MockRequest {
  state: unknown;
  questions: Questions;
  model: string;
}

export type MockScript = (
  request: MockRequest,
) => Record<string, ScriptedAnswer | undefined> | undefined;

/** Stable 32-bit hash so unscripted answers stay deterministic across runs. */
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
 * A distribution peaked on `targetIndex`. `strength` is the mass on the target;
 * the rest decays with distance, so neighbouring levels stay likelier than
 * distant ones.
 */
function peaked(size: number, targetIndex: number, strength: number): number[] {
  if (size === 1) return [1];
  const clamped = Math.min(Math.max(strength, 1 / size), 0.999);
  const weights = Array.from({ length: size }, (_, i) =>
    i === targetIndex ? 0 : 1 / (1 + Math.abs(i - targetIndex) ** 2),
  );
  const total = weights.reduce((sum, w) => sum + w, 0);
  const remainder = 1 - clamped;
  const distribution = weights.map((w) =>
    total === 0 ? remainder / (size - 1) : (w / total) * remainder,
  );
  distribution[targetIndex] = clamped;
  return distribution;
}

/** Renormalizes after rounding so the distribution still sums to exactly 1. */
function normalizeRounded(values: number[]): number[] {
  const rounded = values.map((v) => round(v));
  const drift = round(1 - rounded.reduce((sum, v) => sum + v, 0));
  if (drift !== 0) {
    let max = 0;
    for (let i = 1; i < rounded.length; i++) {
      if ((rounded[i] ?? 0) > (rounded[max] ?? 0)) max = i;
    }
    rounded[max] = round((rounded[max] ?? 0) + drift);
  }
  return rounded;
}

/**
 * Normalized-entropy stand-in for confidence: 1.0 when all mass sits on one
 * outcome. Real Jev calibrates this differently — see the README.
 */
function confidenceFrom(distribution: number[]): number {
  const size = distribution.length;
  if (size <= 1) return 1;
  const entropy = -distribution.reduce((sum, p) => (p > 0 ? sum + p * Math.log(p) : sum), 0);
  return round(Math.max(0, 1 - entropy / Math.log(size)), 4);
}

function buildChoice(question: ChoiceQuestion, scripted: ScriptedAnswer | undefined, seed: string) {
  const options = Object.keys(question.criteria);
  if (options.length === 0) throw new Error('Choice question has no options');

  let distribution: number[];

  if (scripted && 'distribution' in scripted) {
    // An explicit distribution, because `peaked()` decays by index distance and
    // so cannot express "the model is torn between options 1 and 5 specifically".
    // Confusable candidates that are not neighbours are the normal case in a
    // real option set, and the probe-selection examples depend on being able to
    // write one down.
    const given = scripted.distribution;

    for (const key of Object.keys(given)) {
      if (!options.includes(key)) {
        throw new Error(
          `Mock script put mass on "${key}", which is not an option (have: ${options.join(', ')})`,
        );
      }
    }

    const raw = options.map((option) => Math.max(given[option] ?? 0, 0));
    const total = raw.reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
      throw new Error('Mock script supplied a distribution with no positive mass');
    }

    distribution = normalizeRounded(raw.map((value) => value / total));
  } else {
    let targetIndex: number;
    let strength: number;

    if (scripted && 'choice' in scripted) {
      const index = options.indexOf(scripted.choice);
      if (index === -1) {
        throw new Error(`Mock script chose "${scripted.choice}", which is not an option`);
      }
      targetIndex = index;
      strength = scripted.strength ?? 0.88;
    } else {
      targetIndex = Math.floor(hash(seed) * options.length) % options.length;
      strength = 0.45 + hash(`${seed}:strength`) * 0.5;
    }

    distribution = normalizeRounded(peaked(options.length, targetIndex, strength));
  }

  const probabilities: Record<string, number> = {};
  options.forEach((option, index) => {
    probabilities[option] = distribution[index] ?? 0;
  });

  // The reported choice must be the argmax of the distribution.
  let best = options[0] as string;
  for (const option of options) {
    if ((probabilities[option] ?? 0) > (probabilities[best] ?? 0)) best = option;
  }

  return {
    type: 'choice' as const,
    choice: best,
    confidence: confidenceFrom(distribution),
    probabilities,
  };
}

function buildScore(question: ScoreQuestion, scripted: ScriptedAnswer | undefined, seed: string) {
  // The SDK converts score maps to arrays before sending, so the wire form is
  // always an array.
  const criteria = question.criteria as readonly EntryType[];
  const levels = criteria.length;
  if (levels < 2) throw new Error('Score question needs at least 2 levels');

  let target: number;
  let strength: number;

  if (scripted && 'score' in scripted) {
    target = Math.min(Math.max(scripted.score, 0), levels - 1);
    strength = scripted.strength ?? 0.8;
  } else {
    target = hash(seed) * (levels - 1);
    strength = 0.5 + hash(`${seed}:strength`) * 0.4;
  }

  // A score is the probability-weighted mean of its level indices, so the
  // distribution has to be solved for rather than guessed at. Hold a background
  // spread fixed, then place the remaining mass on the two levels bracketing the
  // target so the mean comes out right.
  //
  // Caveat: the peak mass is capped at 0.999 below and the emitted probabilities
  // are rounded, so the reported score lands within ~0.002 of the target rather
  // than exactly on it. Endpoint targets (0 or levels-1) are the worst case.
  const lower = Math.min(Math.floor(target), levels - 2);
  const upper = lower + 1;

  const spread = peaked(levels, Math.round(target), 1 / levels);
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

  const base = spread.map((p) => p * (1 - s));
  base[lower] = (base[lower] ?? 0) + a;
  base[upper] = (base[upper] ?? 0) + (s - a);

  const distribution = normalizeRounded(base);
  const probabilities: Record<string, number> = {};
  const legend: Record<string, EntryType> = {};
  distribution.forEach((p, index) => {
    probabilities[String(index)] = p;
    legend[String(index)] = criteria[index] ?? null;
  });

  return {
    type: 'score' as const,
    score: round(distribution.reduce((sum, p, index) => sum + p * index, 0)),
    confidence: confidenceFrom(distribution),
    legend,
    probabilities,
  };
}

function buildNoul(scripted: ScriptedAnswer | undefined, seed: string) {
  const value = scripted && 'noul' in scripted ? scripted.noul : round(hash(seed));
  return { type: 'noul' as const, noul: round(Math.min(Math.max(value, 0), 1)) };
}

/** Rough token estimate, so the examples can report a plausible cost. */
function estimateTokens(body: unknown): number {
  return Math.ceil(JSON.stringify(body).length / 4);
}

/**
 * Creates a `Fetch` that answers `POST /v1/systemone` locally.
 *
 * @param script - Returns scripted answers per question name. Anything it omits
 *   is derived deterministically from a hash of the question, so unscripted
 *   questions still return stable, plausible values.
 */
export function mockFetch(script?: MockScript): Fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);

    if (!url.endsWith('/v1/systemone')) {
      return new Response(JSON.stringify({ error: { message: `No mock for ${url}` } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    const request = JSON.parse(String(init?.body ?? '{}')) as MockRequest;
    const scripted = script?.(request) ?? {};

    const answers: Record<string, unknown> = {};
    for (const [name, question] of Object.entries(request.questions)) {
      const seed = `${name}:${JSON.stringify(question)}`;
      const hint = scripted[name];

      switch (question.type) {
        case 'choice':
          answers[name] = buildChoice(question, hint, seed);
          break;
        case 'score':
          answers[name] = buildScore(question, hint, seed);
          break;
        case 'noul':
          answers[name] = buildNoul(hint, seed);
          break;
      }
    }

    return new Response(
      JSON.stringify({
        model: request.model,
        answers,
        // Jev generates no text, so output tokens are always zero.
        usage: { input_tokens: estimateTokens(request), output_tokens: 0 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}
