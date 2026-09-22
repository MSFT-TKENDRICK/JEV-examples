/**
 * The policy: what the application does with a distribution.
 *
 * Jev returns a distribution, not a verdict. This file turns one into a
 * decision, and it is deliberately ordinary code: a handful of comparisons and
 * a table of constants that can be argued with in a diff.
 *
 * ## Three routes, and none of them is a person
 *
 *   `act`     — the distribution is peaked enough; expand the step into a plan,
 *               verify the reversible work, commit last.
 *   `probe`   — the distribution is flat and there is still evidence worth
 *               buying; go and read it, then judge again.
 *   `refused` — stop, stating why, having changed nothing.
 *
 * `refused` is terminal. It does not create a work item, does not notify anyone
 * and does not assume anyone is watching. That is the point of it: a program
 * that refuses has finished, whereas a program that queues has merely moved the
 * problem somewhere this repository cannot see.
 *
 * ## The thresholds are illustrative
 *
 * They were chosen to make the fixtures demonstrate distinct branches. They are
 * not empirically selected and not defensible on anyone's data including ours.
 * Choosing them for real means showing, on your own labelled population, that
 * confidence correlates with correctness and that the resulting risk/coverage
 * tradeoff is acceptable — see `docs/FSI-BOUNDARIES.md`.
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
 * that is peaked *and wrong*, which is the failure mode no threshold can see —
 * and which probing does not fix either, because a confidently wrong prior makes
 * every probe look unnecessary.
 */

import type { DistributionMetrics } from '../../../src/ledger.ts';
import type { StepSpec } from '../../../src/workflow-machine.ts';
import { NONE_OF_THESE } from '../../../src/workflow-machine.ts';

export const POLICY_VERSION = 'fsi-07-policy-v1-illustrative';

export const THRESHOLDS = {
  /** Mass on the selected step. */
  minSelectedProbability: 0.7,
  /** Top-1 minus top-2. Catches the tall-but-contested shape. */
  minMargin: 0.25,
  /** Normalized entropy, 0 certain to 1 uniform. Catches the long flat tail. */
  maxNormalizedEntropy: 0.6,
} as const;

/**
 * How much investigating one decision may buy before the application gives up.
 *
 * A budget, not an optimum. Probing is not free and an unbounded loop is a way
 * of never deciding; two reads is enough to show the mechanism and small enough
 * that exhausting it is a real outcome rather than a theoretical one.
 */
export const PROBE_BUDGET = 2;

/** Minimum expected gain, in nats, worth paying a probe's cost for. */
export const MIN_PROBE_GAIN = 0.05;

/** Minimum expected gain as a fraction of the entropy actually present. */
export const MIN_PROBE_GAIN_FRACTION = 0.05;

/** The tunable part of the policy, so a sweep can vary it without copying the tests. */
export type Thresholds = {
  minSelectedProbability: number;
  minMargin: number;
  maxNormalizedEntropy: number;
};

/** Where a decision went. Mirrors the routes the ledger expects. */
export type Route = 'act' | 'probe' | 'refused';

/**
 * What the harness records as the executed action when it refuses.
 *
 * A terminal state of the program. Deliberately not a destination: nothing
 * receives this, and nobody is paged by it.
 */
export const NO_ACTION = 'no_action_taken';

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
  /** Probes already spent on this decision. */
  readonly probesRun: number;
  /**
   * Whether a probe worth running actually exists right now. Computed by
   * `selectProbe` against this distribution — the policy asks, it does not
   * assume.
   */
  readonly probeAvailable: boolean;
  /** Why no probe was selected, when none was. Carried into the refusal reason. */
  readonly probeReason: string;
}

/**
 * Decides what to do with a recommendation.
 *
 * The ordering is load-bearing. A failed call is refused *before* any
 * distribution test, because a missing answer must never be read as a
 * low-confidence one. And ambiguity routes to `probe` before it routes to
 * `refused`, because refusing while evidence remains unbought is giving up
 * early rather than being careful.
 */
export function decide(input: PolicyInput, thresholds: Thresholds = THRESHOLDS): PolicyDecision {
  const { metrics, choice, step, failure, probesRun, probeAvailable, probeReason } = input;

  // Fail closed. A timeout is not an opinion.
  if (failure !== null) {
    return {
      route: 'refused',
      reason: `service call failed (${failure}); failing closed, nothing changed`,
      action: NO_ACTION,
    };
  }

  if (choice === null || metrics === null) {
    return {
      route: 'refused',
      reason: 'no usable answer returned; failing closed, nothing changed',
      action: NO_ACTION,
    };
  }

  if (choice === NONE_OF_THESE) {
    return {
      route: 'refused',
      reason:
        'the eligible set did not contain a suitable next step, and no probe changes ' +
        'which steps are eligible — that is a question about the catalog, not the evidence',
      action: NO_ACTION,
    };
  }

  if (step === null) {
    return {
      route: 'refused',
      reason: `returned "${choice}", which is not a step in the offered set`,
      action: NO_ACTION,
    };
  }

  const failed = failedTests(metrics, thresholds);
  if (failed.length === 0) {
    return {
      route: 'act',
      reason: `all distribution tests passed over ${metrics.optionCount} offered options`,
      action: step.id,
    };
  }

  if (probesRun >= PROBE_BUDGET) {
    return {
      route: 'refused',
      reason:
        `still ambiguous after ${probesRun} probe(s), which exhausts the budget of ` +
        `${PROBE_BUDGET}: ${failed.join('; ')}. Nothing was changed.`,
      action: NO_ACTION,
    };
  }

  if (!probeAvailable) {
    return {
      route: 'refused',
      reason:
        `ambiguous (${failed.join('; ')}) and no probe is worth running: ` +
        `${probeReason}. Nothing was changed.`,
      action: NO_ACTION,
    };
  }

  return {
    route: 'probe',
    reason: `ambiguous (${failed.join('; ')}); buying evidence rather than guessing`,
    action: 'probe',
  };
}

/** Which of the three tests a distribution failed, named individually. */
export function failedTests(
  metrics: DistributionMetrics,
  thresholds: Thresholds = THRESHOLDS,
): string[] {
  const failed: string[] = [];
  if (metrics.selectedProbability < thresholds.minSelectedProbability) {
    failed.push(
      `selected probability ${fmt(metrics.selectedProbability)} < ` +
        `${fmt(thresholds.minSelectedProbability)}`,
    );
  }
  if (metrics.margin < thresholds.minMargin) {
    failed.push(`margin ${fmt(metrics.margin)} < ${fmt(thresholds.minMargin)}`);
  }
  if (metrics.normalizedEntropy > thresholds.maxNormalizedEntropy) {
    failed.push(
      `entropy ${fmt(metrics.normalizedEntropy)} > ${fmt(thresholds.maxNormalizedEntropy)}`,
    );
  }
  return failed;
}

function fmt(value: number): string {
  return value.toFixed(2);
}

/**
 * The thresholds as a plain record, for the ledger's `policy.thresholds`.
 *
 * The three distribution keys keep the names the evaluation sweep reads. The
 * probe constants are recorded alongside them because a refusal caused by an
 * exhausted budget is not the same event as one caused by a flat distribution
 * with nothing worth reading, and a record that cannot tell them apart is not
 * much of a record.
 */
export function thresholdRecord(): Record<string, number> {
  return {
    ...THRESHOLDS,
    probeBudget: PROBE_BUDGET,
    minProbeGain: MIN_PROBE_GAIN,
    minProbeGainFraction: MIN_PROBE_GAIN_FRACTION,
  };
}
