/**
 * A distribution over verdicts, derived from a distribution over rubric levels.
 *
 * This is the hinge of example 02, so it is worth being explicit about what it
 * does and does not do.
 *
 * A Score answer carries probabilities over its levels. The judge does not act
 * on a level, though — it acts on a verdict, which is what comes out of the
 * weighted composite and `gate()`. So: push every level through that same
 * pipeline, see which verdict it produces, and accumulate the level's mass onto
 * that verdict. What falls out is `P(verdict)` implied by the answer the model
 * actually gave.
 *
 * The result is that "the judge is torn" becomes a measured quantity rather than
 * an assertion. A score of 1.5 on a four-level rubric is not automatically
 * ambiguous; it is ambiguous exactly when levels 1 and 2 land in different
 * bands for this candidate's other dimensions. For a candidate whose other
 * dimensions are weak enough that every level of the parent rubric still
 * produces `fail`, the prior is a point mass and there is nothing to
 * investigate — which is a real and useful answer, and one an argmax could not
 * have told you.
 *
 * None of this says the level probabilities are calibrated. It says the
 * arithmetic from those probabilities to a verdict distribution is exact.
 */

import type { ScoreResponse } from '@typesafe-ai/sdk';
import type { Verdict } from '../rubric.ts';

export type VerdictDistribution = Record<Verdict, number>;

export const VERDICTS: readonly Verdict[] = ['pass', 'investigate', 'fail'];

/** Number of levels a Score answer was scored against, read off its own legend. */
export function levelCount(answer: ScoreResponse): number {
  const levels = Object.keys(answer.legend ?? {}).length;
  if (levels < 2) {
    throw new Error(`Expected a legend with at least 2 levels, got ${levels}`);
  }
  return levels;
}

/**
 * @param answer - the Score answer for the parent rubric dimension.
 * @param verdictAtLevel - what the whole judgement would be if the parent
 *   dimension sat at this level, with every other measurement held fixed.
 */
export function verdictPrior(
  answer: ScoreResponse,
  verdictAtLevel: (level: number, levels: number) => Verdict,
): VerdictDistribution {
  const levels = levelCount(answer);
  const prior: VerdictDistribution = { pass: 0, investigate: 0, fail: 0 };

  for (const [key, mass] of Object.entries(answer.probabilities)) {
    const level = Number(key);
    if (!Number.isFinite(level) || mass <= 0) continue;
    prior[verdictAtLevel(level, levels)] += mass;
  }

  let total = 0;
  for (const verdict of VERDICTS) total += prior[verdict];
  if (total <= 0) throw new Error('Score answer carried no probability mass');
  for (const verdict of VERDICTS) prior[verdict] /= total;

  return prior;
}

/**
 * The same prior as an argmax-only interface would have to supply it: all mass
 * on the single level the model reported, and therefore all mass on one verdict.
 *
 * Used by example 02 to show what `eigIsDegenerate()` reports about it. This is
 * a claim about the information a point estimate carries, not about which model
 * produced it — a generative system can be built to probe too, but not from
 * this input alone.
 */
export function collapsedToArgmax(
  levels: number,
  level: number,
  verdictAtLevel: (level: number, levels: number) => Verdict,
): VerdictDistribution {
  const prior: VerdictDistribution = { pass: 0, investigate: 0, fail: 0 };
  prior[verdictAtLevel(level, levels)] = 1;
  return prior;
}
