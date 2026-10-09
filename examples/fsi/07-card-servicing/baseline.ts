/**
 * The baseline arm: the same workflow with no model in it at all.
 *
 * ## Why this exists
 *
 * The honest question about example 07 is "is Jev decoration here?", and it
 * deserves a direct answer rather than a defensive one.
 *
 * Every safety property in this example is owned by deterministic code:
 *
 * | Property | Owner | Needs Jev? |
 * |---|---|---|
 * | Ineligible actions cannot be selected | `computeEligibility` | no |
 * | Principal cannot exceed entitlements | `permits` | no |
 * | Arguments must resolve to records | `bindArguments` | no |
 * | Narrative must be the customer's words | `resolveSpan` | no |
 * | The one irreversible step runs last | `validatePlan` | no |
 * | A reversible step must carry an undo | `validatePlan` | no |
 * | A plan is bound to one frozen proposal | `planDigest` | no |
 * | State cannot go stale under a plan | `preflight` | no |
 * | Failed verification unwinds in reverse | `runPlan` | no |
 *
 * Remove Jev and this arm still runs, still refuses the same things, and still
 * unwinds the same failures. What Jev contributes is **a distribution**: which
 * eligible step leads, by how much, and — when that lead is too thin to act on —
 * a shape with enough entropy in it for `selectProbe` to choose which read would
 * reduce it most. This baseline has neither half. It cannot abstain, because
 * static priority always has an answer, and it cannot probe, because it has no
 * uncertainty to point a probe at.
 *
 * Whether preselection is worth anything — fewer wasted reads, less handling
 * time, better first-choice accuracy — is **not measured here**, and
 * this repository ships no evidence for it. A static priority order is a
 * genuinely strong baseline for a workflow this small, and it may well be the
 * right answer; `docs/FSI-BOUNDARIES.md` question 9 asks exactly that.
 */

import type { Eligibility, StepId, StepSpec } from '../../../src/workflow-machine.ts';

/**
 * Fixed priority, most protective first.
 *
 * Stopping the bleeding outranks paperwork; closing a case outranks nothing.
 * This ordering is a product decision written down as a list, which is both its
 * weakness (it cannot read the case) and its strength (it is stable, auditable,
 * and cannot be moved by the wording of a customer's message).
 */
export const BASELINE_PRIORITY: readonly StepId[] = [
  'freeze_card',
  'open_dispute',
  'order_replacement_card',
  'send_transaction_receipt',
  'schedule_callback',
  'record_customer_note',
  'close_case',
];

export interface BaselineChoice {
  readonly step: StepSpec | null;
  readonly reason: string;
}

/** Picks the highest-priority eligible step. No distribution, no abstention. */
export function baselineNextStep(eligibility: Eligibility): BaselineChoice {
  for (const id of BASELINE_PRIORITY) {
    const step = eligibility.eligible.find((entry) => entry.id === id);
    if (step) {
      return {
        step,
        reason: `highest-priority eligible step in the fixed order (${BASELINE_PRIORITY.indexOf(id) + 1} of ${BASELINE_PRIORITY.length})`,
      };
    }
  }
  return { step: null, reason: 'no eligible step' };
}

/**
 * Picks the first candidate argument, in record order.
 *
 * This is where the baseline is visibly weaker: with several disputable
 * transactions it has no way to tell which one the customer meant, and "first in
 * record order" is arbitrary. It is still *bound* — an arbitrary real
 * transaction, never an invented one — which is the distinction this example is
 * built around.
 */
export function baselineCandidate(candidates: readonly { id: string }[]): string | null {
  return candidates[0]?.id ?? null;
}
