/**
 * Plans: act, verify, compensate.
 *
 * ## What this file replaces
 *
 * It replaces an approval gate. The old design stopped in front of a person
 * whenever a step was consequential, took a signed-off proposal, revalidated it
 * and executed. The revalidation was the good part and it survives here; the
 * person does not.
 *
 * The structural answer to "this action is consequential" is not a signature. It
 * is: put everything reversible and checkable first, verify each of those
 * against a fresh read of the world, and let the single irreversible step — the
 * point of no return — run last, only once the preceding work has been
 * performed *and confirmed*. `validatePlan` in `src/compensate.ts` refuses any
 * plan shaped otherwise, before anything executes.
 *
 * So `open_dispute` is not one call. It is:
 *
 *   1. record the dispute intent on the case        reversible
 *   2. place a provisional credit hold              reversible
 *   3. present the chargeback to the scheme         IRREVERSIBLE, last
 *
 * If step 2 fails verification, step 1 is compensated and step 3 never happens.
 * Nothing reached the scheme, and the case file does not carry an intent for a
 * dispute that was not raised.
 *
 * ## What this does not establish
 *
 * That any of it is *safe*. Reversibility plus verification makes an action
 * **undoable**, which is a smaller and different property. Unfreezing a card
 * restores a status field; it does not restore the payment that declined at a
 * till while the card was blocked. Whether a real card freeze should require
 * authorization is a question about that action, and this repository does not
 * answer it — removing the approval gate removed a demonstration choice, not a
 * risk.
 *
 * ## The preflight is the old revalidation
 *
 * Between the judgement and the commit, the records can move: another channel
 * freezes the card, the issuer reverses the charge. Acting on state that was
 * true when the plan was built rather than state that is true now is a
 * time-of-check to time-of-use bug with a customer's money attached. So every
 * plan preflights against a **fresh read**: same digest, still eligible,
 * arguments still bind. `runPlan` runs every preflight before any step acts, so
 * a plan that was never going to work leaves nothing behind.
 */

import { createHash } from 'node:crypto';
import type { Step } from '../../../src/compensate.ts';
import type { Authority, AuthorityState, Principal } from '../../../src/authority.ts';
import {
  RUN_CLOCK,
  findCard,
  findCase,
  findTransaction,
  formatAmount,
} from '../../../src/authority.ts';
import type {
  BoundValue,
  StepSpec,
  WorkflowContext,
} from '../../../src/workflow-machine.ts';
import {
  bindArguments,
  computeEligibility,
  plainArguments,
} from '../../../src/workflow-machine.ts';

/** A frozen intention to act. Immutable by construction: it is only ever hashed. */
export interface FrozenPlan {
  readonly runId: string;
  readonly stepId: string;
  readonly arguments: Readonly<Record<string, string>>;
  readonly snapshotSource: string;
  readonly snapshotVersion: string;
  readonly actingPrincipal: string;
  readonly builtAt: string;
}

export function freezePlan(
  runId: string,
  step: StepSpec,
  bound: Readonly<Record<string, BoundValue>>,
  context: WorkflowContext,
): FrozenPlan {
  return {
    runId,
    stepId: step.id,
    arguments: plainArguments(bound),
    snapshotSource: context.snapshot.source,
    snapshotVersion: context.snapshot.version,
    actingPrincipal: context.principal.id,
    builtAt: context.snapshot.readAt,
  };
}

/** Key-sorted JSON, so an equal plan digests equally regardless of key order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
}

export function planDigest(plan: FrozenPlan): string {
  return `sha256:${createHash('sha256').update(canonical(plan)).digest('hex').slice(0, 16)}`;
}

/**
 * What every step in a plan is handed.
 *
 * `read()` is the fresh read. Steps verify by calling it again, never by
 * trusting what they just wrote — a step that verified against its own return
 * value would be checking its own homework.
 */
export interface PlanContext {
  readonly authority: Authority;
  readonly frozen: FrozenPlan;
  readonly digest: string;
  readonly step: StepSpec;
  readonly principal: Principal;
  readonly cardId: string;
  readonly sources: WorkflowContext['sources'];
  readonly completed: WorkflowContext['completed'];
  readonly evidence: WorkflowContext['evidence'];
  /**
   * Set by the fixture to make one named plan step fail verification.
   *
   * The rollback fixture needs a verification to fail without the code that
   * fails it pretending to be a real fault. Naming it here keeps the deceit in
   * one visible place.
   */
  readonly failVerificationAt?: string;
}

/** A fresh read, in the shape the deterministic checks already take. */
function contextFrom(context: PlanContext): WorkflowContext {
  return {
    snapshot: context.authority.read(),
    principal: context.principal,
    cardId: context.cardId,
    sources: context.sources,
    // The step being preflighted has not completed yet, so it must not appear
    // here — `computeEligibility` would exclude it as already executed and the
    // preflight would refuse every plan it was handed.
    completed: context.completed.filter((id) => id !== context.step.id),
    evidence: context.evidence,
  };
}

/** Freshness, eligibility and binding, checked together against a new read. */
export function preflight(context: PlanContext): { ok: boolean; detail: string } {
  const { frozen, digest, step } = context;

  if (planDigest(frozen) !== digest) {
    return { ok: false, detail: `plan no longer digests to ${digest}` };
  }

  const fresh = contextFrom(context);

  const eligibility = computeEligibility(fresh);
  if (!eligibility.eligible.some((entry) => entry.id === step.id)) {
    const why =
      eligibility.excluded.find((entry) => entry.id === step.id)?.reason ?? 'no longer eligible';
    return { ok: false, detail: `preconditions changed since the plan was frozen: ${why}` };
  }

  const rebound = bindArguments(step, frozen.arguments, fresh);
  if (!rebound.ok) {
    const first = rebound.rejections[0];
    return { ok: false, detail: `arguments no longer bind: ${first?.slot} — ${first?.reason}` };
  }

  const moved = fresh.snapshot.version !== frozen.snapshotVersion;
  return {
    ok: true,
    detail: moved
      ? `records moved ${frozen.snapshotVersion} → ${fresh.snapshot.version}; rechecked and still hold`
      : `records unchanged at ${frozen.snapshotVersion}`,
  };
}

/** Wraps a verification so the fixture can force exactly one of them to fail. */
function verified(
  context: PlanContext,
  id: string,
  check: () => { ok: boolean; detail: string },
): { ok: boolean; detail: string } {
  if (context.failVerificationAt === id) {
    return { ok: false, detail: 'the downstream service did not confirm the write (fixture)' };
  }
  return check();
}

function write(context: PlanContext, note: string, change: (state: AuthorityState) => void): void {
  context.authority.applyOutOfBandChange(note, change);
}

// ---------------------------------------------------------------------------
// The plans
// ---------------------------------------------------------------------------

/**
 * Expands a selected step into an ordered plan.
 *
 * Every plan holds at most one irreversible step and it is always last. That is
 * not enforced by convention here — `validatePlan` checks it, and `index.ts`
 * refuses to run a plan it rejects.
 */
export function planFor(
  step: StepSpec,
  bound: Readonly<Record<string, BoundValue>>,
): readonly Step<PlanContext>[] {
  const args = plainArguments(bound);

  switch (step.id) {
    case 'freeze_card':
      return freezeCardPlan(args);
    case 'open_dispute':
      return openDisputePlan(args);
    case 'order_replacement_card':
      return replacementPlan(args);
    case 'send_transaction_receipt':
      return receiptPlan(args);
    case 'schedule_callback':
      return callbackPlan(args);
    case 'record_customer_note':
      return notePlan(args);
    case 'close_case':
      return closeCasePlan(args);
  }
}

function freezeCardPlan(args: Record<string, string>): readonly Step<PlanContext>[] {
  const cardId = args['cardId'] ?? '';

  return [
    {
      id: 'block_authorizations',
      description: `block further authorizations on ${cardId}`,
      reversible: true,
      preflight,
      act: (context) =>
        write(context, `harness froze ${cardId}`, (state) => {
          state.cards = state.cards.map((card) =>
            card.cardId === cardId ? { ...card, status: 'frozen' } : card,
          );
        }),
      verify: (context) =>
        verified(context, 'block_authorizations', () => {
          const card = findCard(context.authority.read(), cardId);
          return card?.status === 'frozen'
            ? { ok: true, detail: `${cardId} reads status=frozen on a fresh snapshot` }
            : { ok: false, detail: `${cardId} reads status=${card?.status ?? 'missing'}` };
        }),
      compensate: (context) =>
        write(context, `harness unfroze ${cardId}`, (state) => {
          state.cards = state.cards.map((card) =>
            card.cardId === cardId ? { ...card, status: 'active' } : card,
          );
        }),
    },
  ];
}

function openDisputePlan(args: Record<string, string>): readonly Step<PlanContext>[] {
  const transactionId = args['transactionId'] ?? '';
  const amountMinor = Number(args['amountMinor'] ?? 0);
  const holdId = `HOLD-${transactionId}`;

  return [
    {
      id: 'record_dispute_intent',
      description: `note the intended dispute on the case`,
      reversible: true,
      preflight,
      act: (context) =>
        write(context, `harness recorded dispute intent on ${transactionId}`, (state) => {
          const open = state.cases.find((entry) => entry.status === 'open');
          if (open) {
            state.disputeIntents = [
              ...state.disputeIntents,
              { caseId: open.caseId, transactionId, note: args['narrative'] ?? '' },
            ];
          }
        }),
      verify: (context) =>
        verified(context, 'record_dispute_intent', () => {
          const found = context.authority
            .read()
            .disputeIntents.some((entry) => entry.transactionId === transactionId);
          return found
            ? { ok: true, detail: `intent for ${transactionId} is on the case file` }
            : { ok: false, detail: `no intent recorded for ${transactionId}` };
        }),
      compensate: (context) =>
        write(context, `harness removed the dispute intent on ${transactionId}`, (state) => {
          state.disputeIntents = state.disputeIntents.filter(
            (entry) => entry.transactionId !== transactionId,
          );
        }),
    },
    {
      id: 'place_provisional_credit_hold',
      description: `hold ${formatAmount(amountMinor, 'GBP')} provisionally`,
      reversible: true,
      preflight,
      act: (context) =>
        write(context, `harness placed a provisional hold on ${transactionId}`, (state) => {
          state.creditHolds = [
            ...state.creditHolds,
            { holdId, transactionId, amountMinor, status: 'held' },
          ];
        }),
      verify: (context) =>
        verified(context, 'place_provisional_credit_hold', () => {
          const hold = context.authority
            .read()
            .creditHolds.find((entry) => entry.holdId === holdId);
          return hold?.status === 'held'
            ? { ok: true, detail: `${holdId} reads status=held` }
            : { ok: false, detail: `${holdId} reads status=${hold?.status ?? 'missing'}` };
        }),
      compensate: (context) =>
        write(context, `harness released ${holdId}`, (state) => {
          state.creditHolds = state.creditHolds.map((entry) =>
            entry.holdId === holdId ? { ...entry, status: 'released' } : entry,
          );
        }),
    },
    {
      id: 'present_chargeback_to_scheme',
      description: 'present the chargeback — the point of no return',
      // No compensate(). A claim that has reached the scheme cannot be unmade,
      // and `validatePlan` rejects a plan that supplies one here.
      reversible: false,
      preflight,
      act: (context) =>
        write(context, `harness presented a chargeback on ${transactionId}`, (state) => {
          state.transactions = state.transactions.map((entry) =>
            entry.transactionId === transactionId
              ? { ...entry, disputeId: 'DSP-40012' }
              : entry,
          );
        }),
      verify: (context) =>
        verified(context, 'present_chargeback_to_scheme', () => {
          const entry = findTransaction(context.authority.read(), transactionId);
          return entry?.disputeId !== null && entry?.disputeId !== undefined
            ? { ok: true, detail: `${transactionId} carries dispute ${entry.disputeId}` }
            : { ok: false, detail: `${transactionId} carries no dispute identifier` };
        }),
    },
  ];
}

function replacementPlan(args: Record<string, string>): readonly Step<PlanContext>[] {
  const cardId = args['cardId'] ?? '';

  return [
    {
      id: 'dispatch_replacement',
      description: `order a replacement for ${cardId} to the address on file`,
      // A card that has entered the post cannot be recalled.
      reversible: false,
      preflight,
      act: (context) =>
        write(context, `harness ordered a replacement for ${cardId}`, (state) => {
          state.cards = state.cards.map((card) =>
            card.cardId === cardId ? { ...card, replacementOrderedAt: RUN_CLOCK } : card,
          );
        }),
      verify: (context) =>
        verified(context, 'dispatch_replacement', () => {
          const card = findCard(context.authority.read(), cardId);
          return card?.replacementOrderedAt !== null && card?.replacementOrderedAt !== undefined
            ? { ok: true, detail: `${cardId} records a replacement ordered` }
            : { ok: false, detail: `${cardId} records no replacement` };
        }),
    },
  ];
}

function receiptPlan(args: Record<string, string>): readonly Step<PlanContext>[] {
  const transactionId = args['transactionId'] ?? '';

  return [
    {
      id: 'send_detail_to_customer',
      description: `send the full merchant and timing detail for ${transactionId}`,
      // A sent message has no inverse.
      reversible: false,
      preflight,
      act: (context) =>
        write(context, `harness sent transaction detail for ${transactionId}`, (state) => {
          state.notifications = [...state.notifications, `detail:${transactionId}`];
        }),
      verify: (context) =>
        verified(context, 'send_detail_to_customer', () => {
          const sent = context.authority
            .read()
            .notifications.includes(`detail:${transactionId}`);
          return sent
            ? { ok: true, detail: `the messaging service reports detail for ${transactionId} delivered` }
            : { ok: false, detail: 'the messaging service reports nothing delivered' };
        }),
    },
  ];
}

function callbackPlan(args: Record<string, string>): readonly Step<PlanContext>[] {
  const slotId = args['slotId'] ?? '';

  return [
    {
      id: 'hold_scheduler_slot',
      description: `hold ${slotId} against this case`,
      reversible: true,
      preflight,
      act: (context) =>
        write(context, `harness held ${slotId}`, (state) => {
          state.notifications = [...state.notifications, `slot:${slotId}`];
        }),
      verify: (context) =>
        verified(context, 'hold_scheduler_slot', () => {
          const held = context.authority.read().notifications.includes(`slot:${slotId}`);
          return held
            ? { ok: true, detail: `the scheduler reports ${slotId} held` }
            : { ok: false, detail: `the scheduler does not report ${slotId} held` };
        }),
      compensate: (context) =>
        write(context, `harness released ${slotId}`, (state) => {
          state.notifications = state.notifications.filter((entry) => entry !== `slot:${slotId}`);
        }),
    },
  ];
}

function notePlan(args: Record<string, string>): readonly Step<PlanContext>[] {
  const note = args['note'] ?? '';

  return [
    {
      id: 'attach_untrusted_note',
      description: 'attach the customer’s message to the case, tagged untrusted',
      reversible: true,
      preflight,
      act: (context) =>
        write(context, 'harness attached a customer note', (state) => {
          const open = state.cases.find((entry) => entry.status === 'open');
          if (open) {
            state.disputeIntents = [
              ...state.disputeIntents,
              { caseId: open.caseId, transactionId: '(none)', note },
            ];
          }
        }),
      verify: (context) =>
        verified(context, 'attach_untrusted_note', () => {
          const found = context.authority
            .read()
            .disputeIntents.some((entry) => entry.note === note);
          return found
            ? { ok: true, detail: 'the note is on the case, tagged untrusted' }
            : { ok: false, detail: 'the note is not on the case' };
        }),
      compensate: (context) =>
        write(context, 'harness removed the customer note', (state) => {
          state.disputeIntents = state.disputeIntents.filter((entry) => entry.note !== note);
        }),
    },
  ];
}

function closeCasePlan(args: Record<string, string>): readonly Step<PlanContext>[] {
  const caseId = args['caseId'] ?? '';

  return [
    {
      id: 'mark_case_resolved',
      description: `mark ${caseId} resolved`,
      reversible: true,
      preflight,
      act: (context) =>
        write(context, `harness closed ${caseId}`, (state) => {
          state.cases = state.cases.map((entry) =>
            entry.caseId === caseId ? { ...entry, status: 'closed' } : entry,
          );
        }),
      verify: (context) =>
        verified(context, 'mark_case_resolved', () => {
          const record = findCase(context.authority.read(), caseId);
          return record?.status === 'closed'
            ? { ok: true, detail: `${caseId} reads status=closed` }
            : { ok: false, detail: `${caseId} reads status=${record?.status ?? 'missing'}` };
        }),
      compensate: (context) =>
        write(context, `harness reopened ${caseId}`, (state) => {
          state.cases = state.cases.map((entry) =>
            entry.caseId === caseId ? { ...entry, status: 'open' } : entry,
          );
        }),
    },
  ];
}
