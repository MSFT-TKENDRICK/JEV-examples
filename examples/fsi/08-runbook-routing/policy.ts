/**
 * The routing policy: thresholds, and what happens when they are not met.
 *
 * Two design points carry most of the weight here.
 *
 * **The default is the ordinary operations queue.** Every path that is not an
 * affirmative pass lands there, including every failure path. The queue is where
 * these incidents went before any of this existed, so the fallback is not a
 * degraded mode — it is the status quo, and it does not depend on the service
 * answering, answering quickly, or answering correctly.
 *
 * **Thresholds are illustrative.** They were chosen to make the fixture paths
 * legible in a terminal. They are not empirically selected, they are not
 * calibrated, and they are not portable: a threshold tuned against six candidate
 * procedures is not valid for twenty, because the probabilities themselves move
 * when the option set changes.
 */

import type { DistributionMetrics } from '../../../src/ledger.ts';

/** Every terminal route this example can take. */
export type Route =
  | 'deterministic_runbook'
  | 'linked_to_predecessor'
  | 'scheduler_retry'
  | 'freeze_downstream'
  | 'suppressed_duplicate'
  | 'runbook_suggested'
  | 'ops_queue';

export const POLICY_VERSION = '08-runbook-routing/illustrative-v1';

export const THRESHOLDS = {
  /** Minimum mass on the selected procedure. */
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

export interface PolicyInput {
  choice: string;
  metrics: DistributionMetrics;
  evidenceSufficient: number;
  /** `none-of-these` is a valid answer and is always routed to a human. */
  isNoneOption: boolean;
  /** Result of revalidating the recommendation against authoritative state. */
  precondition: { holds: boolean; reason?: string };
}

export interface PolicyDecision {
  route: Route;
  reason: string;
  /** Every condition that failed, so the output is diagnosable rather than binary. */
  failed: readonly string[];
}

/**
 * Applies the policy.
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
      route: 'ops_queue',
      reason: 'answered none-of-these; the catalog does not cover this evidence',
      failed: ['none-of-these'],
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
  if (!precondition.holds) {
    failed.push(`preconditions do not hold: ${precondition.reason ?? 'unspecified'}`);
  }

  if (failed.length > 0) {
    return {
      route: 'ops_queue',
      reason: !precondition.holds
        ? 'recommendation refused by revalidation against authoritative state'
        : 'distribution did not meet the policy for an unattended suggestion',
      failed,
    };
  }

  return {
    route: 'runbook_suggested',
    reason: `${choice} suggested as the first diagnostic step for the assigned engineer`,
    failed,
  };
}

/** What the failure of a call means. Never an approval, never a route. */
export function fallbackFor(kind: 'timeout' | 'malformed_response' | 'service_error'): PolicyDecision {
  return {
    route: 'ops_queue',
    reason: `no usable answer (${kind}); routed exactly as it would have been without the service`,
    failed: [kind],
  };
}
