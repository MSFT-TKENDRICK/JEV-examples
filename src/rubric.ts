/**
 * Helpers for turning Jev's raw answers into decisions.
 *
 * The important idea: Jev returns a calibrated judgment, not a verdict. Your
 * code owns the weights, the thresholds and the escalation policy. Everything
 * here is deliberately small and boring so it stays yours to tune.
 */

import type { EvaluationResult, QuestionMap, ScoreAnswer } from './jev.ts';

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
 * Distributions are optional in the spec, so this returns `undefined` rather
 * than assuming. Note this is the selected option's probability, which is a
 * different statistic from TypeSafe's `confidence`.
 */
export function selectedProbability(answer: {
  choice: string;
  probabilities?: Record<string, number>;
}): number | undefined {
  return answer.probabilities?.[answer.choice];
}

/**
 * True when the model split its mass across several options instead of
 * committing to one. The usual response is to ask a narrower question rather
 * than to act on a coin flip.
 */
export function isAmbiguous(
  answer: { choice: string; probabilities?: Record<string, number> },
  threshold = 0.6,
): boolean {
  const probability = selectedProbability(answer);
  return probability === undefined ? false : probability < threshold;
}

/** Options ordered by probability, highest first. Useful for fallback candidates. */
export function rankedOptions(answer: {
  probabilities?: Record<string, number>;
}): Array<{ option: string; probability: number }> {
  if (!answer.probabilities) return [];
  return Object.entries(answer.probabilities)
    .map(([option, probability]) => ({ option, probability }))
    .sort((a, b) => b.probability - a.probability);
}

/** Convenience wrapper that normalizes a Score answer given its question. */
export function normalizedAnswer<Q extends QuestionMap>(
  result: EvaluationResult<Q>,
  questions: Q,
  id: keyof Q & string,
): number {
  const question = questions[id];
  if (!question || question.type !== 'score') {
    throw new Error(`Question "${id}" is not a Score question`);
  }
  const answer = result.answers[id] as ScoreAnswer;
  return normalizeScore(answer.score, question.criteria.length);
}
