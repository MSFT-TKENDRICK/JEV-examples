/**
 * Helpers for turning Jev's answers into decisions.
 *
 * The important idea: Jev returns a distribution, not a verdict. Your
 * code owns the weights, the thresholds and the escalation policy. Everything
 * here is deliberately small and boring so it stays yours to tune — the SDK
 * gives you the measurement, this file is the part you were always going to
 * write yourself.
 */

import type { ScoreResponse } from '@typesafe-ai/sdk';

/** Any answer carrying a probability distribution. */
type Distributed = { readonly probabilities: { readonly [key: string]: number } };
type Chosen = Distributed & { readonly choice: string };

/**
 * Maps a raw score onto 0..1.
 *
 * A Score answer lands in [0, levels - 1], so the divisor is `levels - 1`, not
 * `levels`. Getting this wrong silently compresses every score you compute.
 */
export function normalizeScore(score: number, levelCount: number): number {
  if (levelCount < 2) throw new Error('A Score question must have at least 2 levels');
  return score / (levelCount - 1);
}

export interface WeightedDimension {
  /** Normalized 0..1 value for this dimension. */
  value: number;
  /** Relative importance. Weights are normalized, so they need not sum to 1. */
  weight: number;
}

/**
 * Combines independent dimensions into one number.
 *
 * Use this for compensating preferences, where strength in one dimension can
 * legitimately offset weakness in another. Do NOT use it for a safety gate:
 * "any serious violation blocks" is a separate condition, not a low weight.
 */
export function weightedScore(dimensions: Record<string, WeightedDimension>): number {
  const entries = Object.values(dimensions);
  const totalWeight = entries.reduce((sum, d) => sum + d.weight, 0);
  if (totalWeight <= 0) throw new Error('Total weight must be greater than 0');
  return entries.reduce((sum, d) => sum + (d.weight / totalWeight) * d.value, 0);
}

export type Verdict = 'pass' | 'review' | 'fail';

export interface GateOptions {
  /** At or above this, the item passes automatically. */
  pass: number;
  /** Below this, the item fails outright. Between the two, a human looks. */
  fail: number;
}

/** Turns a 0..1 value into a three-way decision with an explicit review band. */
export function gate(value: number, { pass, fail }: GateOptions): Verdict {
  if (fail > pass) throw new Error('`fail` threshold must not exceed `pass` threshold');
  if (value >= pass) return 'pass';
  if (value < fail) return 'fail';
  return 'review';
}

/**
 * Reads the probability the model assigned to the option it actually selected.
 *
 * Note this is the selected option's probability, which is a different
 * statistic from the `confidence` the SDK reports on the same answer.
 */
export function selectedProbability(answer: Chosen): number {
  return answer.probabilities[answer.choice] ?? 0;
}

/**
 * True when the model split its mass across several options instead of
 * committing to one. The usual response is to ask a narrower question rather
 * than to act on a coin flip.
 */
export function isAmbiguous(answer: Chosen, threshold = 0.6): boolean {
  return selectedProbability(answer) < threshold;
}

/** Options ordered by probability, highest first. Useful for fallback candidates. */
export function rankedOptions(
  answer: Distributed,
): Array<{ option: string; probability: number }> {
  return Object.entries(answer.probabilities)
    .map(([option, probability]) => ({ option, probability }))
    .sort((a, b) => b.probability - a.probability);
}

/**
 * Normalizes a Score answer to 0..1 without restating its rubric.
 *
 * The SDK returns the rubric as `legend` on the answer, so the level count is
 * already there — no need to thread the question through.
 *
 * `legend` is required by the SDK's types, but the SDK does not runtime-validate
 * responses, so a truncated or absent legend would silently mis-normalize. Pass
 * `levelCount` explicitly when you already know it and want that guarantee.
 */
export function normalized(answer: ScoreResponse, levelCount?: number): number {
  const levels = levelCount ?? Object.keys(answer.legend ?? {}).length;
  if (levels < 2) {
    throw new Error(
      `Cannot normalize: expected a legend with at least 2 levels, got ${levels}. ` +
        'Pass levelCount explicitly if the response omits its legend.',
    );
  }
  return normalizeScore(answer.score, levels);
}
