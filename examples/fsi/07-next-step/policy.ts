/**
 * The abstention and escalation policy.
 *
 * Jev returns a distribution, not a verdict. This file is the part that turns
 * one into a decision, and it is deliberately ordinary code: four comparisons
 * and a table of constants that a reviewer can argue with.
 *
 * ## The thresholds are illustrative
 *
 * They were chosen to make the fixtures demonstrate distinct branches. They are
 * not empirically selected, and they are not defensible on anyone's data
 * including ours. Choosing them for real means showing, on your own labelled
 * population, that confidence correlates with correctness and that the resulting
 * risk/coverage tradeoff is acceptable — see `docs/FSI-BOUNDARIES.md`.
 *
 * ## Thresholds are not portable across option counts
 *
 * A 0.70 selected-probability bar means something quite different over three
 * options than over twenty, so `optionCount` is recorded on every decision and
 * is taken from the options *offered*, not from whatever the service returned.
 *
 * ## Three tests, not one
 *
 * Peak height, margin and entropy fail differently. A distribution can be tall
 * but contested (0.45/0.44/0.11), or flat with a clear leader. Requiring all
 * three narrows what counts as actionable. None of this detects a distribution
 * that is peaked *and wrong*, which is the failure mode abstention cannot see.
 */

import type { DistributionMetrics } from '../../../src/ledger.ts';
import type { StepSpec } from '../../../src/workflow-machine.ts';
import { NONE_OF_THESE } from '../../../src/workflow-machine.ts';

export const POLICY_VERSION = 'fsi-07-policy-v0-illustrative';

export const THRESHOLDS = {
  /** Mass on the selected step. */
  minSelectedProbability: 0.7,
  /** Top-1 minus top-2. Catches the tall-but-contested shape. */
  minMargin: 0.25,
  /** Normalized entropy, 0 certain to 1 uniform. Catches the long flat tail. */
  maxNormalizedEntropy: 0.6,
} as const;

/** Where a decision went. Mirrors the routes the ledger expects. */
export type Route = 'auto' | 'approval_required' | 'escalated' | 'refused';

/** What the harness does when it will not act on the recommendation. */
export const HUMAN_QUEUE = 'route_to_servicing_queue';

export interface PolicyDecision {
  readonly route: Route;
  readonly reason: string;
  /** The action the harness will actually take, which may not be the recommendation. */
  readonly action: string;
}

export interface PolicyInput {
  /** Absent when the call failed, which is not the same as a low-confidence answer. */
  readonly metrics: DistributionMetrics | null;
  readonly choice: string | null;
  /** Resolved from the choice. Absent when the choice was not a step. */
  readonly step: StepSpec | null;
  /** Set when the service call failed outright. */
  readonly failure: string | null;
}

/**
 * Decides what to do with a recommendation.
 *
 * The ordering is load-bearing. A failed call is refused *before* any
 * distribution test, because a missing answer must never be read as a
 * low-confidence one, and a low-confidence one must never be read as a refusal
 * to act — they route to different places and mean different things.
 */
export function decide(input: PolicyInput): PolicyDecision {
  const { metrics, choice, step, failure } = input;

  // Fail closed. A timeout is not an opinion.
  if (failure !== null) {
    return {
      route: 'refused',
      reason: `service call failed (${failure}); failing closed`,
      action: HUMAN_QUEUE,
    };
  }

  if (choice === null || metrics === null) {
    return {
      route: 'refused',
      reason: 'no usable answer returned; failing closed',
      action: HUMAN_QUEUE,
    };
  }

  if (choice === NONE_OF_THESE) {
    return {
      route: 'escalated',
      reason: 'the eligible set did not contain a suitable next step',
      action: HUMAN_QUEUE,
    };
  }

  if (step === null) {
    return {
      route: 'refused',
      reason: `returned "${choice}", which is not a step in the offered set`,
      action: HUMAN_QUEUE,
    };
  }

  const failed = failedTests(metrics);
  if (failed.length > 0) {
    return {
      route: 'escalated',
      reason: `distribution too ambiguous to act on: ${failed.join('; ')}`,
      action: HUMAN_QUEUE,
    };
  }

  if (step.consequential) {
    return {
      route: 'approval_required',
      reason: `${step.id} is configured consequential; ${step.approvalBy} approval required`,
      action: step.id,
    };
  }

  return {
    route: 'auto',
    reason: `all distribution tests passed over ${metrics.optionCount} offered options`,
    action: step.id,
  };
}

/** Which of the three tests a distribution failed, named individually. */
export function failedTests(metrics: DistributionMetrics): string[] {
  const failed: string[] = [];
  if (metrics.selectedProbability < THRESHOLDS.minSelectedProbability) {
    failed.push(
      `selected probability ${fmt(metrics.selectedProbability)} < ` +
        `${fmt(THRESHOLDS.minSelectedProbability)}`,
    );
  }
  if (metrics.margin < THRESHOLDS.minMargin) {
    failed.push(`margin ${fmt(metrics.margin)} < ${fmt(THRESHOLDS.minMargin)}`);
  }
  if (metrics.normalizedEntropy > THRESHOLDS.maxNormalizedEntropy) {
    failed.push(
      `entropy ${fmt(metrics.normalizedEntropy)} > ${fmt(THRESHOLDS.maxNormalizedEntropy)}`,
    );
  }
  return failed;
}

function fmt(value: number): string {
  return value.toFixed(2);
}

/** The thresholds as a plain record, for the ledger's `policy.thresholds`. */
export function thresholdRecord(): Record<string, number> {
  return { ...THRESHOLDS };
}
