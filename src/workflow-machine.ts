/**
 * The code-owned workflow state machine.
 *
 * ## The ordering that matters
 *
 *   1. read the authoritative records                     (src/authority.ts)
 *   2. compute which steps are eligible, deterministically (this file)
 *   3. offer *only* those steps to Jev as Choice options    (recommend.ts)
 *   4. apply an explicit abstention policy to the answer    (policy.ts)
 *   5. bind arguments, step-specifically, to records        (this file)
 *   6. require approval, revalidate, then execute           (approval.ts)
 *
 * Steps 1, 2, 5 and 6 are ordinary code and hold whether or not Jev is in the
 * loop at all — `baseline.ts` runs exactly the same path with the model removed.
 * What Jev contributes is which eligible step to try first. That is a
 * prioritization benefit, and this repository does not measure it.
 *
 * ## Two design constraints inherited from the claim contract
 *
 * **Ask for the next workflow step, not "which tool to call".** Freezing a card,
 * opening a dispute and scheduling a callback are co-applicable — a servicing
 * case may need all three. Forcing co-applicable actions into one Choice asks an
 * ill-posed question, and a confident answer to an ill-posed question is still
 * wrong. So the loop runs a step at a time and recomputes eligibility after each
 * one.
 *
 * **Bind arguments in a separate, step-specific stage.** Independently selected
 * marginals do not compose: the most likely step and the most likely transaction
 * are not jointly the most likely action, and which arguments are even
 * meaningful depends on the step that was selected. Candidate argument sets are
 * therefore constructed *after* a step is chosen, from the records, and never
 * from free text.
 */

import type {
  AuthoritySnapshot,
  Capability,
  Principal,
  PrincipalRole,
  SourceDocument,
} from './authority.ts';
import {
  describeMerchant,
  findCallbackSlot,
  findCard,
  findCase,
  findMerchant,
  findTransaction,
  formatAmount,
  permits,
  resolveSpan,
} from './authority.ts';

export type StepId =
  | 'freeze_card'
  | 'order_replacement_card'
  | 'open_dispute'
  | 'schedule_callback'
  | 'send_transaction_receipt'
  | 'record_customer_note'
  | 'close_case';

/**
 * The option offered alongside the eligible steps so the model is never forced
 * to pick a wrong one.
 *
 * An explicit escape hatch does not solve the missing-correct-option problem —
 * the model may still prefer a plausible near-miss over admitting the set is
 * wrong — but removing it guarantees a wrong answer whenever the right step is
 * not on the list.
 */
export const NONE_OF_THESE = 'none_of_these';

/** How a slot gets filled, which is a governance question more than a technical one. */
export type SlotFiller =
  /** Chosen from a bounded candidate set built from the records. */
  | 'candidate_selection'
  /** Derived by code from an already-bound record. Never model-supplied. */
  | 'deterministic'
  /** The customer's exact words, quoted from a permitted source document. */
  | 'verbatim_customer_text'
  /** Stored as untrusted input. Never interpreted, never executed. */
  | 'untrusted_passthrough';

export type SlotKind =
  | 'record_reference'
  | 'record_field'
  | 'scheduler_slot'
  | 'source_span'
  | 'untrusted_note';

export interface SlotSpec {
  readonly name: string;
  readonly kind: SlotKind;
  readonly filledBy: SlotFiller;
  readonly description: string;
  /** For `record_reference`: which system the identifier must exist in. */
  readonly recordType?: 'card' | 'transaction' | 'merchant' | 'case';
  /** For `record_field`: the bound slot and field the value must equal. */
  readonly derivedFrom?: { readonly slot: string; readonly field: 'amountMinor' | 'merchantId' };
}

export interface StepSpec {
  readonly id: StepId;
  readonly label: string;
  /** The text handed to Jev as this option's Choice criterion. */
  readonly description: string;
  readonly capability: Capability;
  /**
   * Consequential steps require a named human approval before execution.
   * Consequence is a property of the action, configured here, not something a
   * model is asked to assess.
   */
  readonly consequential: boolean;
  /** Which principal must approve. Roles are not interchangeable. */
  readonly approvalBy: PrincipalRole | null;
  readonly slots: readonly SlotSpec[];
}

export interface WorkflowContext {
  readonly snapshot: AuthoritySnapshot;
  readonly principal: Principal;
  /** The card the servicing channel resolved deterministically, before any model ran. */
  readonly cardId: string;
  /** Permitted source documents for `source_span` slots. */
  readonly sources: readonly SourceDocument[];
  /** Steps already executed in this run, so the loop does not repeat itself. */
  readonly completed: readonly StepId[];
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export const STEPS: readonly StepSpec[] = [
  {
    id: 'freeze_card',
    label: 'Freeze the card',
    description:
      'Block further authorizations on the card in scope. Appropriate when the customer ' +
      'reports activity they did not authorize and the card is still usable.',
    capability: 'freeze_card',
    consequential: true,
    approvalBy: 'customer',
    slots: [
      {
        name: 'cardId',
        kind: 'record_reference',
        recordType: 'card',
        filledBy: 'candidate_selection',
        description: 'The card to block, by system-of-record identifier.',
      },
    ],
  },
  {
    id: 'order_replacement_card',
    label: 'Order a replacement card',
    description:
      'Issue a new card to the address already on file. Appropriate only once the existing ' +
      'card is no longer usable.',
    capability: 'order_replacement_card',
    consequential: true,
    approvalBy: 'customer',
    slots: [
      {
        name: 'cardId',
        kind: 'record_reference',
        recordType: 'card',
        filledBy: 'candidate_selection',
        description: 'The card being replaced.',
      },
    ],
  },
  {
    id: 'open_dispute',
    label: 'Open a dispute',
    description:
      'Start a formal chargeback for one posted transaction the customer says they did not ' +
      'make. Appropriate when a specific transaction has been identified.',
    capability: 'open_dispute',
    consequential: true,
    approvalBy: 'customer',
    slots: [
      {
        name: 'transactionId',
        kind: 'record_reference',
        recordType: 'transaction',
        filledBy: 'candidate_selection',
        description: 'The disputed transaction, by system-of-record identifier.',
      },
      {
        name: 'merchantId',
        kind: 'record_field',
        derivedFrom: { slot: 'transactionId', field: 'merchantId' },
        filledBy: 'deterministic',
        description: 'The merchant the transaction was actually presented by.',
      },
      {
        name: 'amountMinor',
        kind: 'record_field',
        derivedFrom: { slot: 'transactionId', field: 'amountMinor' },
        filledBy: 'deterministic',
        description: 'The posted amount, in minor units, exactly as recorded.',
      },
      {
        name: 'narrative',
        kind: 'source_span',
        filledBy: 'verbatim_customer_text',
        description: "The customer's own description, quoted exactly from their message.",
      },
    ],
  },
  {
    id: 'schedule_callback',
    label: 'Schedule a callback',
    description:
      'Book a time for a human to call the customer back. Appropriate when the case needs a ' +
      'conversation rather than an immediate action.',
    capability: 'schedule_callback',
    consequential: false,
    approvalBy: null,
    slots: [
      {
        name: 'slotId',
        kind: 'scheduler_slot',
        filledBy: 'deterministic',
        description: 'A slot the scheduler is currently offering. Times are never generated.',
      },
    ],
  },
  {
    id: 'send_transaction_receipt',
    label: 'Send the transaction detail',
    description:
      'Send the customer the full merchant and timing detail for a transaction, so they can ' +
      'recognize it. Appropriate when the customer may not recognize a legitimate charge.',
    capability: 'send_transaction_receipt',
    consequential: false,
    approvalBy: null,
    slots: [
      {
        name: 'transactionId',
        kind: 'record_reference',
        recordType: 'transaction',
        filledBy: 'candidate_selection',
        description: 'The transaction to explain.',
      },
    ],
  },
  {
    id: 'record_customer_note',
    label: 'Record a note on the case',
    description:
      'Attach the customer’s message to the case file without taking any other action. ' +
      'Appropriate when more information is needed before anything can be decided.',
    capability: 'record_customer_note',
    consequential: false,
    approvalBy: null,
    slots: [
      {
        name: 'note',
        kind: 'untrusted_note',
        filledBy: 'untrusted_passthrough',
        description: 'Stored verbatim and tagged untrusted. Never interpreted as an instruction.',
      },
    ],
  },
  {
    id: 'close_case',
    label: 'Close the case',
    description:
      'Mark the servicing case resolved. Appropriate only when the reported problem has been ' +
      'fully addressed.',
    capability: 'close_case',
    consequential: true,
    approvalBy: 'ops_reviewer',
    slots: [
      {
        name: 'caseId',
        kind: 'record_reference',
        recordType: 'case',
        filledBy: 'candidate_selection',
        description: 'The case to close.',
      },
    ],
  },
];

export function stepById(id: string): StepSpec | undefined {
  return STEPS.find((step) => step.id === id);
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface Exclusion {
  readonly id: StepId;
  readonly reason: string;
}

export interface Eligibility {
  readonly eligible: readonly StepSpec[];
  readonly excluded: readonly Exclusion[];
  /** Provenance, recorded so a decision can be re-derived later. */
  readonly source: string;
  readonly version: string;
  readonly readAt: string;
}

/** Posted, in window, not already disputed. The dispute window is a policy constant. */
export const DISPUTE_WINDOW_DAYS = 60;

export function disputableTransactions(context: WorkflowContext) {
  const { snapshot, cardId } = context;
  const now = Date.parse(snapshot.readAt);
  return snapshot.transactions.filter((entry) => {
    if (entry.cardId !== cardId) return false;
    if (entry.status !== 'posted') return false;
    if (entry.disputeId !== null) return false;
    const ageDays = (now - Date.parse(entry.postedAt)) / 86_400_000;
    return ageDays <= DISPUTE_WINDOW_DAYS;
  });
}

/**
 * Decides, in code, which steps may even be offered.
 *
 * Every branch below is a precondition on a record or an entitlement. None of
 * them is a judgment call, and none of them consults a model. An action excluded
 * here is not ranked low for Jev — it is absent from the option set, so no
 * distribution over the options can select it.
 */
export function computeEligibility(context: WorkflowContext): Eligibility {
  const { snapshot, principal, cardId, completed } = context;
  const card = findCard(snapshot, cardId);
  const eligible: StepSpec[] = [];
  const excluded: Exclusion[] = [];
  const openCases = snapshot.cases.filter((entry) => entry.status === 'open');
  const disputable = disputableTransactions(context);
  const postedForCard = snapshot.transactions.filter(
    (entry) => entry.cardId === cardId && entry.status === 'posted',
  );

  for (const step of STEPS) {
    const reason = ineligibleReason(step.id, {
      card,
      openCases,
      disputable,
      postedForCard,
      snapshot,
      completed,
    });

    if (!permits(principal, step.capability)) {
      excluded.push({
        id: step.id,
        reason: `principal ${principal.role} is not entitled to ${step.capability}`,
      });
      continue;
    }
    if (reason !== null) {
      excluded.push({ id: step.id, reason });
      continue;
    }
    eligible.push(step);
  }

  return {
    eligible,
    excluded,
    source: snapshot.source,
    version: snapshot.version,
    readAt: snapshot.readAt,
  };
}

interface PreconditionInputs {
  readonly card: ReturnType<typeof findCard>;
  readonly openCases: readonly { readonly caseId: string }[];
  readonly disputable: readonly { readonly transactionId: string }[];
  readonly postedForCard: readonly { readonly transactionId: string }[];
  readonly snapshot: AuthoritySnapshot;
  readonly completed: readonly StepId[];
}

/** Returns null when the step is eligible, or the reason it is not. */
function ineligibleReason(id: StepId, inputs: PreconditionInputs): string | null {
  const { card, openCases, disputable, postedForCard, snapshot, completed } = inputs;

  if (completed.includes(id)) return 'already executed in this run';
  if (!card) return 'card in scope not found in the system of record';

  switch (id) {
    case 'freeze_card':
      return card.status === 'active' ? null : `card is already ${card.status}`;
    case 'order_replacement_card':
      if (card.status === 'active') return 'card is still active; nothing to replace yet';
      if (card.replacementOrderedAt !== null) return 'a replacement is already on its way';
      return null;
    case 'open_dispute':
      return disputable.length > 0
        ? null
        : `no posted, undisputed transaction within ${DISPUTE_WINDOW_DAYS} days`;
    case 'schedule_callback':
      return snapshot.callbackSlots.length > 0 ? null : 'the scheduler is offering no slots';
    case 'send_transaction_receipt':
      return postedForCard.length > 0 ? null : 'no posted transaction on this card';
    case 'record_customer_note':
      return openCases.length > 0 ? null : 'no open case to attach a note to';
    case 'close_case':
      if (openCases.length === 0) return 'no open case';
      if (card.status === 'active') return 'card is still active on a reported-fraud case';
      if (disputable.length > 0) return 'a disputable transaction is still unresolved';
      return null;
  }
}

// ---------------------------------------------------------------------------
// Candidate arguments — built after a step is selected, never before
// ---------------------------------------------------------------------------

export interface Candidate {
  readonly id: string;
  readonly label: string;
}

export function candidatesFor(
  step: StepSpec,
  slot: SlotSpec,
  context: WorkflowContext,
): readonly Candidate[] {
  const { snapshot, cardId } = context;

  if (slot.kind === 'scheduler_slot') {
    return snapshot.callbackSlots.map((entry) => ({
      id: entry.slotId,
      label: `${entry.startsAt} · ${entry.channel}`,
    }));
  }

  if (slot.recordType === 'card') {
    const usable =
      step.id === 'freeze_card'
        ? snapshot.cards.filter((entry) => entry.status === 'active')
        : snapshot.cards.filter((entry) => entry.status !== 'closed');
    return usable.map((entry) => ({
      id: entry.cardId,
      label: `•••• ${entry.last4} (${entry.network}, ${entry.status})`,
    }));
  }

  if (slot.recordType === 'transaction') {
    const pool =
      step.id === 'open_dispute'
        ? disputableTransactions(context)
        : snapshot.transactions.filter((entry) => entry.cardId === cardId);
    return pool.map((entry) => ({
      id: entry.transactionId,
      label:
        `${formatAmount(entry.amountMinor, entry.currency)} at ` +
        `${describeMerchant(snapshot, entry.merchantId)} on ${entry.postedAt.slice(0, 10)}`,
    }));
  }

  if (slot.recordType === 'case') {
    return snapshot.cases
      .filter((entry) => entry.status === 'open')
      .map((entry) => ({ id: entry.caseId, label: `opened ${entry.openedAt.slice(0, 10)}` }));
  }

  return [];
}

// ---------------------------------------------------------------------------
// Binding — the check that does the actual rejecting
// ---------------------------------------------------------------------------

export interface BoundValue {
  readonly value: string;
  /** Where the value came from, so the ledger can show it was not invented. */
  readonly boundTo: string;
}

export interface Rejection {
  readonly slot: string;
  readonly proposed: string;
  readonly reason: string;
}

export type BindingResult =
  | { readonly ok: true; readonly bound: Readonly<Record<string, BoundValue>> }
  | { readonly ok: false; readonly rejections: readonly Rejection[] };

/**
 * Binds proposed arguments to authoritative records, or rejects them.
 *
 * This runs identically on a Jev-selected proposal, a generatively-proposed one
 * and a deterministic baseline one. That symmetry is the point: an execution
 * argument that does not resolve to a record in the snapshot is rejected here,
 * regardless of which model produced it — and equally, a *bound* argument is not
 * thereby a correct one. Binding establishes that the identifier exists and is
 * consistent, nothing more. Picking the wrong real transaction passes every
 * check in this function.
 */
export function bindArguments(
  step: StepSpec,
  proposed: Readonly<Record<string, string>>,
  context: WorkflowContext,
): BindingResult {
  const { snapshot, sources } = context;
  const bound: Record<string, BoundValue> = {};
  const rejections: Rejection[] = [];
  const known = `${snapshot.source}@${snapshot.version}`;

  for (const name of Object.keys(proposed)) {
    if (!step.slots.some((slot) => slot.name === name)) {
      rejections.push({
        slot: name,
        proposed: proposed[name] ?? '',
        reason: `${step.id} has no argument named "${name}"`,
      });
    }
  }

  // Record references resolve first, because derived fields are checked against
  // the records they resolved to.
  const ordered = [...step.slots].sort((a, b) => slotOrder(a) - slotOrder(b));

  for (const slot of ordered) {
    const value = proposed[slot.name];

    if (slot.kind === 'record_reference') {
      if (value === undefined) {
        rejections.push({ slot: slot.name, proposed: '(absent)', reason: 'required argument' });
        continue;
      }
      const candidates = candidatesFor(step, slot, context);
      const exists =
        (slot.recordType === 'card' && findCard(snapshot, value) !== undefined) ||
        (slot.recordType === 'transaction' && findTransaction(snapshot, value) !== undefined) ||
        (slot.recordType === 'merchant' && findMerchant(snapshot, value) !== undefined) ||
        (slot.recordType === 'case' && findCase(snapshot, value) !== undefined);

      if (!exists) {
        rejections.push({
          slot: slot.name,
          proposed: value,
          reason: `no ${slot.recordType} with this identifier in ${known}`,
        });
        continue;
      }
      if (!candidates.some((candidate) => candidate.id === value)) {
        rejections.push({
          slot: slot.name,
          proposed: value,
          reason: `${slot.recordType} exists but is not an eligible candidate for ${step.id}`,
        });
        continue;
      }
      bound[slot.name] = { value, boundTo: `${known} ${slot.recordType}` };
      continue;
    }

    if (slot.kind === 'record_field') {
      const from = slot.derivedFrom;
      const reference = from ? bound[from.slot] : undefined;
      if (!from || !reference) {
        rejections.push({
          slot: slot.name,
          proposed: value ?? '(absent)',
          reason: unboundFieldReason(slot, from, value, snapshot, known),
        });
        continue;
      }
      const transaction = findTransaction(snapshot, reference.value);
      if (!transaction) {
        rejections.push({
          slot: slot.name,
          proposed: value ?? '(absent)',
          reason: `referenced transaction vanished from ${known}`,
        });
        continue;
      }
      const authoritative = String(transaction[from.field]);
      // Absent is fine: code derives it. Present and different is a rejection,
      // and that is how an invented amount or merchant is caught.
      if (value !== undefined && value !== authoritative) {
        rejections.push({
          slot: slot.name,
          proposed: value,
          reason:
            `does not match ${from.field} on ${reference.value} ` +
            `in ${known} (authoritative: ${authoritative})`,
        });
        continue;
      }
      bound[slot.name] = {
        value: authoritative,
        boundTo: `${known} transaction ${reference.value}.${from.field}`,
      };
      continue;
    }

    if (slot.kind === 'scheduler_slot') {
      if (value === undefined) {
        rejections.push({ slot: slot.name, proposed: '(absent)', reason: 'required argument' });
        continue;
      }
      if (findCallbackSlot(snapshot, value) === undefined) {
        rejections.push({
          slot: slot.name,
          proposed: value,
          reason: 'not a slot the scheduler is currently offering',
        });
        continue;
      }
      bound[slot.name] = { value, boundTo: 'scheduler availability' };
      continue;
    }

    if (slot.kind === 'source_span') {
      if (value === undefined) {
        rejections.push({ slot: slot.name, proposed: '(absent)', reason: 'required argument' });
        continue;
      }
      const span = resolveSpan(sources, value);
      if (!span) {
        rejections.push({
          slot: slot.name,
          proposed: value,
          reason: 'not an exact quotation from a permitted source document',
        });
        continue;
      }
      bound[slot.name] = {
        value: span.text,
        boundTo: `${span.sourceId}[${span.start}..${span.end}]`,
      };
      continue;
    }

    // untrusted_note: stored, never interpreted.
    if (value === undefined) {
      rejections.push({ slot: slot.name, proposed: '(absent)', reason: 'required argument' });
      continue;
    }
    bound[slot.name] = { value, boundTo: 'untrusted customer input (stored, not interpreted)' };
  }

  return rejections.length > 0 ? { ok: false, rejections } : { ok: true, bound };
}

function slotOrder(slot: SlotSpec): number {
  return slot.kind === 'record_reference' ? 0 : 1;
}

/**
 * Explains why a derived field could not be bound when its record did not bind.
 *
 * Worth being specific rather than emitting one cascade message for everything.
 * A merchant identifier is independently checkable against the directory, so say
 * so. An amount is not: money is only authoritative *relative to a transaction*,
 * and "£264.99" is neither right nor wrong until it is attached to one. Saying
 * that plainly is more useful to a reviewer than pretending the check was the
 * same in both cases.
 */
function unboundFieldReason(
  slot: SlotSpec,
  from: SlotSpec['derivedFrom'],
  value: string | undefined,
  snapshot: AuthoritySnapshot,
  known: string,
): string {
  if (value === undefined) return 'cannot derive: the record it depends on did not bind';

  if (from?.field === 'merchantId') {
    return findMerchant(snapshot, value) === undefined
      ? `no merchant with this identifier in ${known}`
      : `merchant exists in ${known}, but the transaction it must match did not bind`;
  }

  if (from?.field === 'amountMinor') {
    return (
      'cannot be checked on its own: an amount is authoritative only relative to a ' +
      `transaction, and the referenced transaction did not resolve in ${known}`
    );
  }

  return 'cannot derive: the record it depends on did not bind';
}

/** The bound arguments as plain strings, for the ledger and the report. */
export function plainArguments(
  bound: Readonly<Record<string, BoundValue>>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(bound).map(([name, value]) => [name, value.value]));
}

/**
 * Fills the slots code already knows the answer to, so a model is never asked.
 *
 * This is the "route work away from Jev" rule made concrete. Callback times come
 * from the scheduler. Dispute narratives are the customer's exact words. Derived
 * fields come from the record. The card is whichever card the servicing channel
 * already resolved before any model ran, and a single open case is not a choice.
 *
 * What is left for a model is only the genuinely open question: which of several
 * real transactions the customer meant.
 */
export function deterministicArguments(
  step: StepSpec,
  context: WorkflowContext,
): Record<string, string> {
  const filled: Record<string, string> = {};

  for (const slot of step.slots) {
    if (slot.kind === 'scheduler_slot') {
      const first = context.snapshot.callbackSlots[0];
      if (first) filled[slot.name] = first.slotId;
      continue;
    }
    if (slot.kind === 'source_span' || slot.kind === 'untrusted_note') {
      const source = context.sources[0];
      if (source) filled[slot.name] = source.text;
      continue;
    }
    if (slot.kind === 'record_reference' && slot.recordType === 'card') {
      filled[slot.name] = context.cardId;
      continue;
    }
    if (slot.kind === 'record_reference' && slot.recordType === 'case') {
      const open = context.snapshot.cases.filter((entry) => entry.status === 'open');
      const only = open.length === 1 ? open[0] : undefined;
      if (only) filled[slot.name] = only.caseId;
    }
  }

  return filled;
}

/**
 * The slots a model is actually asked about: candidate-selection slots that code
 * could not already fill. Usually one, often none.
 */
export function slotsNeedingSelection(
  step: StepSpec,
  context: WorkflowContext,
): readonly SlotSpec[] {
  const known = deterministicArguments(step, context);
  return step.slots.filter(
    (slot) => slot.filledBy === 'candidate_selection' && known[slot.name] === undefined,
  );
}
