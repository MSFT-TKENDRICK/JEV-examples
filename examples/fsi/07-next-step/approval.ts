/**
 * Approval, and revalidation against fresh state.
 *
 * ## Approval is a separate step, not a property of the recommendation
 *
 * Jev recommended a step. A named human then approves a *specific, frozen
 * proposal* — this step, these bound arguments, against this version of the
 * record. The approval is bound to a digest of that proposal, so an approval
 * cannot be carried over to a different action, different arguments, or a
 * different card. Change anything and the digest changes and the approval no
 * longer applies.
 *
 * ## Why revalidate after approval
 *
 * Between proposal and execution, a human thought about it. Meanwhile another
 * channel may have frozen the card, the issuer may have reversed the charge, or
 * an earlier dispute may have landed. Acting on state that was true when the
 * approval was given, rather than state that is true now, is a time-of-check to
 * time-of-use bug with a customer's money attached.
 *
 * So execution re-reads the records, recomputes eligibility, and re-binds every
 * argument. If any of that now fails, the approval is not honoured.
 *
 * ## What this is not
 *
 * A human confirming an action is not, by itself, authorization, regulatory
 * sufficiency, or an operational control. Approval queues are also where
 * automation bias lives: a reviewer shown a preselected answer tends to accept
 * it, and an unstaffed queue approves everything eventually. This code records
 * who approved what. It does not establish that the approval was meaningful —
 * see `docs/FSI-BOUNDARIES.md`, question 7.
 */

import { createHash } from 'node:crypto';
import type { Principal } from '../../../src/authority.ts';
import type {
  BoundValue,
  StepSpec,
  WorkflowContext,
} from '../../../src/workflow-machine.ts';
import { bindArguments, computeEligibility, plainArguments } from '../../../src/workflow-machine.ts';

/** A frozen intention to act. Immutable by construction: it is only ever hashed. */
export interface Proposal {
  readonly runId: string;
  readonly stepId: string;
  readonly arguments: Readonly<Record<string, string>>;
  readonly snapshotSource: string;
  readonly snapshotVersion: string;
  readonly proposedFor: string;
  readonly proposedAt: string;
}

export interface Approval {
  readonly digest: string;
  readonly principal: Principal;
  readonly decision: 'approved' | 'declined';
  readonly at: string;
  readonly note?: string;
}

export function buildProposal(
  runId: string,
  step: StepSpec,
  bound: Readonly<Record<string, BoundValue>>,
  context: WorkflowContext,
): Proposal {
  return {
    runId,
    stepId: step.id,
    arguments: plainArguments(bound),
    snapshotSource: context.snapshot.source,
    snapshotVersion: context.snapshot.version,
    proposedFor: context.principal.id,
    proposedAt: context.snapshot.readAt,
  };
}

/** Key-sorted JSON, so an equal proposal digests equally regardless of key order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
}

export function digestOf(proposal: Proposal): string {
  return `sha256:${createHash('sha256').update(canonical(proposal)).digest('hex').slice(0, 16)}`;
}

export type Revalidation =
  | {
      readonly ok: true;
      readonly bound: Readonly<Record<string, BoundValue>>;
      /** Set when the records moved but the preconditions still hold. */
      readonly note: string | null;
    }
  | { readonly ok: false; readonly reason: string };

export interface RevalidateInput {
  readonly proposal: Proposal;
  readonly approval: Approval;
  readonly step: StepSpec;
  /** A context built from a *fresh* read, not the one the proposal was built on. */
  readonly fresh: WorkflowContext;
}

/**
 * The last gate before anything happens.
 *
 * Every check here is a comparison between a frozen proposal and the world as it
 * is now. None of them consults a model, and all of them run identically for a
 * Jev-selected proposal, a generatively-proposed one and a baseline one.
 */
export function revalidate({ proposal, approval, step, fresh }: RevalidateInput): Revalidation {
  const expected = digestOf(proposal);

  if (approval.digest !== expected) {
    return {
      ok: false,
      reason: `approval is bound to ${approval.digest}, but this proposal digests to ${expected}`,
    };
  }
  if (approval.decision !== 'approved') {
    return { ok: false, reason: `${approval.principal.role} declined` };
  }
  if (step.approvalBy !== null && approval.principal.role !== step.approvalBy) {
    return {
      ok: false,
      reason:
        `${step.id} requires ${step.approvalBy} approval, ` +
        `but it was approved by ${approval.principal.role}`,
    };
  }

  // Re-read preconditions. The records may have moved while a human decided.
  const eligibility = computeEligibility(fresh);
  const stillEligible = eligibility.eligible.some((entry) => entry.id === step.id);
  if (!stillEligible) {
    const why =
      eligibility.excluded.find((entry) => entry.id === step.id)?.reason ?? 'no longer eligible';
    return {
      ok: false,
      reason: `preconditions changed since approval: ${why}`,
    };
  }

  // Re-bind against the fresh snapshot. An identifier valid at proposal time is
  // not automatically valid now.
  const rebound = bindArguments(step, proposal.arguments, fresh);
  if (!rebound.ok) {
    const first = rebound.rejections[0];
    return {
      ok: false,
      reason: `arguments no longer bind: ${first?.slot} — ${first?.reason}`,
    };
  }

  const moved = fresh.snapshot.version !== proposal.snapshotVersion;
  return {
    ok: true,
    bound: rebound.bound,
    note: moved
      ? `records moved ${proposal.snapshotVersion} → ${fresh.snapshot.version} ` +
        'after approval; preconditions and arguments rechecked and still hold'
      : null,
  };
}
