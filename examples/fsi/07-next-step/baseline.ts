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
 * | Consequential actions need approval | `STEPS[].consequential` | no |
 * | Approval is bound to one frozen proposal | `digestOf` | no |
 * | State cannot go stale under an approval | `revalidate` | no |
 *
 * Remove Jev and this arm still runs, still refuses the same things, and still
 * requires the same approvals. What Jev contributes is **which eligible step to
 * put in front of the human first**, and a distribution shape that the policy
 * can abstain on when the case is genuinely unclear. This baseline has no way to
 * abstain: it always has an answer, because static priority always has an answer.
 *
 * Whether preselection is worth anything — fewer clarification turns, less
 * handling time, better first-choice accuracy — is **not measured here**, and
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
 * weakness (it cannot read the case) and its strength (it is reviewable, stable,
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
