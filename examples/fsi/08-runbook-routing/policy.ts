/**
 * The routing policy: thresholds, the investigation budget, and what happens
 * when the distribution will not concentrate.
 *
 * Three design points carry the weight here.
 *
 * **There is no queue.** Every route this file can return is a machine action or
 * a terminal refusal. Nothing parks a decision in front of a person, and nothing
 * creates work for one. When the evidence does not support acting, the program
 * either goes and gets more evidence or stops having changed nothing.
 *
 * **Refusing is terminal, and it is not a failure mode to be minimised.** A run
 * that refuses has produced a correct outcome: it has stated what it could not
 * establish, and it has left the incident exactly as it found it. The temptation
 * to soften a refusal into "raised for attention" is precisely the thing this
 * design removed.
 *
 * **Thresholds and budgets are illustrative.** They were chosen to make the
 * fixture paths legible in a terminal. They are not empirically selected, not
 * calibrated, and not portable: a threshold tuned against seven candidate
 * remediations is not valid for twenty, because the probabilities themselves
 * move when the option set changes. The same is true of the probe budget —
 * `maxCostUnits` is denominated in units this repository invented.
 */

import type { DistributionMetrics } from '../../../src/ledger.ts';

/**
 * Every route this example can take.
 *
 * The names are the ones `src/ledger.ts` documents, so an external reader of the
 * ledger — including `examples/fsi/eval` — sees the vocabulary the ledger's own
 * comments describe rather than a private dialect.
 *
 * `probe` is the only non-terminal route. Everything else ends the incident.
 */
export type Route =
  // Resolved by a lookup, before any request was built.
  | 'deterministic_runbook'
  | 'linked_to_predecessor'
  | 'scheduler_retry'
  | 'freeze_downstream'
  | 'suppressed_duplicate'
  // The investigation loop.
  | 'probe'
  // Terminal outcomes of acting.
  | 'act'
  | 'rolled_back'
  | 'inconsistent'
  // Terminal outcome of not acting.
  | 'refused';

export const POLICY_VERSION = '08-runbook-routing/eig-illustrative-v1';

export const THRESHOLDS = {
  /** Minimum mass on the selected remediation before it is executed. */
  minSelectedProbability: 0.7,
  /** Minimum top-1 minus top-2. Catches "peaked, but contested". */
  minMargin: 0.25,
  /** Maximum normalized entropy. Catches mass smeared across the tail. */
  maxNormalizedEntropy: 0.6,
  /** Minimum on the model's own sufficiency answer, which is also a model output. */
  minEvidenceSufficient: 0.6,
} as const;

/** The tunable part of the policy, so a sweep can vary it without copying the tests. */
export type Thresholds = {
  minSelectedProbability: number;
  minMargin: number;
  maxNormalizedEntropy: number;
  minEvidenceSufficient: number;
};

/**
 * What the investigation is allowed to spend before it gives up.
 *
 * Two dimensions, not one, and the second is the interesting one. A count-only
 * budget makes every diagnostic equally affordable, which quietly removes the
 * reason to rank on cost at all. With a cost ceiling, an expensive diagnostic
 * can be the highest-gain option available and still be the wrong thing to run,
 * which is the trade an overnight batch window forces constantly.
 */
export const INVESTIGATION = {
  /** Diagnostics runnable per incident. */
  maxProbes: 3,
  /** Total authored cost units spendable per incident. Not minutes. */
  maxCostUnits: 5,
  /**
   * Absolute floor, in nats, on what a diagnostic must be expected to remove.
   * Below this the loop stops probing; whether it then acts or refuses is
   * decided by the thresholds above, not by this number.
   */
  minimumGain: 0.05,
  /**
   * Floor as a fraction of the prior entropy. Scale-independent and usually the
   * more meaningful of the two: removing 0.1 nats means something very different
   * against a prior of 0.15 nats than against one of 2.0.
   */
  minimumGainFraction: 0.08,
  /**
   * Stop probing once the leader holds this much mass, whatever gain remains on
   * the table.
   *
   * This is a budget rule, not an optimality result. A cheap diagnostic against
   * a 0.88 leader can still carry real expected gain, because the 12% branch
   * would genuinely change the answer. What this encodes is a decision that the
   * flip is not worth paying to find.
   */
  decisionThreshold: 0.88,
} as const;

export interface PolicyInput {
  choice: string;
  metrics: DistributionMetrics;
  evidenceSufficient: number;
  /** `none-of-these` is a valid answer, and it means the catalog does not apply. */
  isNoneOption: boolean;
  /** Result of revalidating the recommendation against authoritative state. */
  precondition: { holds: boolean; reason?: string };
}

export interface PolicyDecision {
  /** `act` when the distribution supports executing; otherwise `refused`. */
  route: 'act' | 'refused';
  reason: string;
  /** Every condition that failed, so the output is diagnosable rather than binary. */
  failed: readonly string[];
  /**
   * True when the only thing standing between this distribution and an action is
   * its shape — so more evidence could change the answer.
   *
   * False when the block is categorical: `none-of-these`, or a precondition that
   * authoritative state does not satisfy. Neither of those gets better by
   * looking harder at the same incident, so the loop must not spend budget
   * probing them.
   */
  probeable: boolean;
}

/**
 * Applies the policy to one judgement.
 *
 * Note the precondition check. It is not one vote among several: it can veto a
 * recommendation that passed every distribution test, and it is the only check
 * here whose input is authoritative state rather than a model output. A demo
 * where the model is always right never exercises it.
 */
export function decide(input: PolicyInput, thresholds: Thresholds = THRESHOLDS): PolicyDecision {
  const { choice, metrics, evidenceSufficient, isNoneOption, precondition } = input;

  if (isNoneOption) {
    return {
      route: 'refused',
      reason:
        'answered none-of-these; no remediation in the catalog addresses this evidence, ' +
        'and no diagnostic would change that',
      failed: ['none-of-these'],
      probeable: false,
    };
  }

  const failed: string[] = [];
  if (metrics.selectedProbability < thresholds.minSelectedProbability) {
    failed.push(
      `selected probability ${metrics.selectedProbability.toFixed(2)} < ${thresholds.minSelectedProbability}`,
    );
  }
  if (metrics.margin < thresholds.minMargin) {
    failed.push(`margin ${metrics.margin.toFixed(2)} < ${thresholds.minMargin}`);
  }
  if (metrics.normalizedEntropy > thresholds.maxNormalizedEntropy) {
    failed.push(
      `normalized entropy ${metrics.normalizedEntropy.toFixed(2)} > ${thresholds.maxNormalizedEntropy}`,
    );
  }
  if (evidenceSufficient < thresholds.minEvidenceSufficient) {
    failed.push(
      `evidence sufficiency ${evidenceSufficient.toFixed(2)} < ${thresholds.minEvidenceSufficient}`,
    );
  }

  // Checked last and reported separately, because it is the one failure that no
  // amount of further evidence about *this* incident can clear.
  if (!precondition.holds) {
    return {
      route: 'refused',
      reason: 'recommendation refused by revalidation against authoritative state',
      failed: [...failed, `preconditions do not hold: ${precondition.reason ?? 'unspecified'}`],
      probeable: false,
    };
  }

  if (failed.length > 0) {
    return {
      route: 'refused',
      reason: 'distribution does not support acting on this evidence',
      failed,
      probeable: true,
    };
  }

  return {
    route: 'act',
    reason: `${choice} meets the policy for unattended execution`,
    failed,
    probeable: true,
  };
}

/**
 * What the failure of a call means.
 *
 * A decision point that cannot answer must not stall the batch window and must
 * not invent an action. It stops, having changed nothing. Note what is *not*
 * here: no retry-with-a-person, no degraded route, no parking space.
 */
export function refusalFor(
  kind: 'timeout' | 'malformed_response' | 'service_error',
): PolicyDecision {
  return {
    route: 'refused',
    reason: `no usable answer (${kind}); stopped without changing anything`,
    failed: [kind],
    probeable: false,
  };
}
