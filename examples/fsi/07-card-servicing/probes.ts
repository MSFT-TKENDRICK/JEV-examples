/**
 * The probe catalog — what the application goes and reads when it is torn.
 *
 * ## The rule this file implements
 *
 * When the distribution over next steps is flat, the application does not ask
 * anyone. It works out **what evidence would separate the leading candidates**,
 * fetches exactly that, and judges again with the finding in the state.
 *
 * Which lookup to run is not scripted. `selectProbe` in
 * `src/information-gain.ts` ranks every probe below by expected reduction in
 * entropy per unit cost, against the distribution actually returned. The probes
 * have genuinely different costs and their observations partition the candidate
 * steps genuinely differently, so the ranking moves when the distribution moves.
 *
 * ## What is authored, and it is most of this file
 *
 * Which probes exist, what they cost, and how their observations partition the
 * candidates are **written here by hand**. The arithmetic over those inputs is
 * real; the inputs are manufactured. Change the partition and the selection
 * changes, which is exactly why the selection being computed is a smaller claim
 * than it first sounds.
 *
 * Two properties are load-bearing and both are checked below rather than
 * asserted in prose:
 *
 * 1. **Probes are read-only.** Every `run` here goes through an exported lookup
 *    in `src/authority.ts` and none of them calls `applyOutOfBandChange`. A
 *    probe that changed the records would be an action wearing an
 *    investigation's clothes.
 * 2. **Probes are cheaper than the action they inform.** `ACTION_COST` below is
 *    the notional cost of taking a workflow step, and `assertProbesAreCheap()`
 *    fails the run if any probe is not strictly cheaper. Probing that costs more
 *    than acting is an argument for acting, and an example that quietly
 *    inverted that would be arguing for itself dishonestly.
 *
 * ## What a probe returns
 *
 * A bounded observation label, never a record. `device_fingerprint` is the
 * clearest case: `deviceMatchFor()` reads a fingerprint hash and returns
 * `known_device` / `unrecognised_device` / `no_signal`. The hash never leaves
 * `src/authority.ts`, so probing does not quietly reopen what the withheld-field
 * list closed.
 */

import type { Probe } from '../../../src/information-gain.ts';
import { partitionProbe } from '../../../src/information-gain.ts';
import type { AuthoritySnapshot } from '../../../src/authority.ts';
import {
  activeMandateWith,
  authorizationVelocity,
  describeMerchant,
  deviceMatchFor,
  findCard,
  focalTransaction,
  formatAmount,
  priorDisputesWith,
  transactionHistoryFor,
} from '../../../src/authority.ts';
import type { EvidenceRecord, StepId } from '../../../src/workflow-machine.ts';

/**
 * The notional cost of taking a workflow step, in the same units as probe cost.
 *
 * A single number standing in for something that is not one number — a freeze
 * and a chargeback do not cost the same thing to anybody. It exists to make the
 * cheaper-than-the-action property checkable rather than merely claimed.
 */
export const ACTION_COST = 10;

/** What a probe needs to do its read. */
export interface ProbeContext {
  readonly snapshot: AuthoritySnapshot;
  readonly cardId: string;
}

/** An observation, plus the plain-language reading that goes into the state. */
export interface Observation {
  readonly observation: string;
  readonly detail: string;
}

export interface WorkflowProbe {
  readonly probe: Probe;
  /** What this probe reads, named so a reviewer can check it is a read. */
  readonly reads: string;
  /** Performs the lookup. Read-only by construction: it takes a snapshot. */
  run(context: ProbeContext): Observation;
}

// ---------------------------------------------------------------------------
// The partitions
//
// Each bucket lists the candidate steps that observation would point towards.
// A step absent from every bucket is treated as uninformative for that probe
// rather than impossible — see `partitionProbe`.
// ---------------------------------------------------------------------------

const DISPUTE: StepId = 'open_dispute';
const RECEIPT: StepId = 'send_transaction_receipt';
const FREEZE: StepId = 'freeze_card';
const REPLACE: StepId = 'order_replacement_card';
const CALLBACK: StepId = 'schedule_callback';
const NOTE: StepId = 'record_customer_note';
const CLOSE: StepId = 'close_case';

/**
 * The catalog.
 *
 * Costs are ordered the way the underlying lookups actually differ in a bank: a
 * card status read is a cache hit, a scheme dispute history lookup is a batch
 * interface someone pays for. The *ratios* are invented; the ordering is the
 * part worth defending.
 */
export const PROBES: readonly WorkflowProbe[] = [
  {
    reads: 'the card record',
    probe: partitionProbe(
      'card_status',
      1,
      {
        card_active: [FREEZE, DISPUTE, RECEIPT, NOTE],
        card_already_blocked: [REPLACE, DISPUTE, CLOSE],
      },
      'Is the card still able to take authorizations?',
    ),
    run: ({ snapshot, cardId }) => {
      const card = findCard(snapshot, cardId);
      if (!card) return { observation: 'card_already_blocked', detail: 'card not found' };
      return card.status === 'active'
        ? { observation: 'card_active', detail: 'the card can still take authorizations' }
        : {
            observation: 'card_already_blocked',
            detail: `the card is already ${card.status}, so blocking it is not the open question`,
          };
    },
  },
  {
    reads: 'the device signal service',
    probe: partitionProbe(
      'device_fingerprint',
      2,
      {
        known_device: [RECEIPT, NOTE, CALLBACK],
        unrecognised_device: [FREEZE, DISPUTE, REPLACE],
        no_signal: [],
      },
      'Was the charge presented by a device this account has used before?',
    ),
    run: ({ snapshot, cardId }) => {
      const focus = focalTransaction(snapshot, cardId);
      if (!focus) return { observation: 'no_signal', detail: 'no transaction to check a device against' };

      const match = deviceMatchFor(snapshot, focus.transactionId);
      const detail =
        match === 'known_device'
          ? `the charge was presented by a device this account has used before`
          : match === 'unrecognised_device'
            ? 'the charge was presented by a device never seen on this account'
            : 'the device service holds no signal for this charge';
      // The label, never the fingerprint.
      return { observation: match, detail };
    },
  },
  {
    reads: 'the standing-instruction register',
    probe: partitionProbe(
      'merchant_mandate',
      2,
      {
        recurring_mandate_found: [RECEIPT, NOTE, CALLBACK],
        no_mandate: [DISPUTE, FREEZE, REPLACE],
      },
      'Did the customer set up a standing instruction with this merchant?',
    ),
    run: ({ snapshot, cardId }) => {
      const focus = focalTransaction(snapshot, cardId);
      if (!focus) return { observation: 'no_mandate', detail: 'no transaction to check a mandate against' };

      const mandate = activeMandateWith(snapshot, focus.merchantId);
      const merchant = describeMerchant(snapshot, focus.merchantId);
      return mandate
        ? {
            observation: 'recurring_mandate_found',
            detail:
              `an active ${mandate.cadence} standing instruction with ${merchant} ` +
              `has been in place since ${mandate.startedAt.slice(0, 10)}`,
          }
        : {
            observation: 'no_mandate',
            detail: `no standing instruction with ${merchant} on this account`,
          };
    },
  },
  {
    reads: 'the posted-transaction history',
    probe: partitionProbe(
      'transaction_history',
      3,
      {
        prior_settled_with_merchant: [RECEIPT, NOTE],
        first_time_merchant: [DISPUTE, FREEZE],
      },
      'Has this account paid this merchant before without complaint?',
    ),
    run: ({ snapshot, cardId }) => {
      const focus = focalTransaction(snapshot, cardId);
      if (!focus) {
        return { observation: 'first_time_merchant', detail: 'no transaction history to read' };
      }
      const merchant = describeMerchant(snapshot, focus.merchantId);
      const earlier = transactionHistoryFor(snapshot, cardId).filter(
        (entry) =>
          entry.merchantId === focus.merchantId &&
          entry.transactionId !== focus.transactionId &&
          entry.status === 'posted',
      );

      return earlier.length > 0
        ? {
            observation: 'prior_settled_with_merchant',
            detail:
              `${earlier.length} earlier settled payment(s) to ${merchant}, most recently ` +
              `${formatAmount(earlier[0]?.amountMinor ?? 0, earlier[0]?.currency ?? 'GBP')} ` +
              `on ${earlier[0]?.postedAt.slice(0, 10)}`,
          }
        : {
            observation: 'first_time_merchant',
            detail: `no earlier settled payment to ${merchant} on this account`,
          };
    },
  },
  {
    reads: 'the authorization velocity control',
    probe: partitionProbe(
      'velocity_check',
      4,
      {
        burst_detected: [FREEZE, REPLACE, DISPUTE],
        normal_velocity: [RECEIPT, NOTE, CALLBACK, CLOSE],
      },
      'Is the card authorizing faster than it normally does?',
    ),
    run: ({ snapshot, cardId }) => {
      const reading = authorizationVelocity(snapshot, cardId);
      return reading.burst
        ? {
            observation: 'burst_detected',
            detail: `${reading.count} authorizations in the last ${reading.windowHours}h, above this card's normal rate`,
          }
        : {
            observation: 'normal_velocity',
            detail: `${reading.count} authorizations in the last ${reading.windowHours}h, within normal range`,
          };
    },
  },
  {
    reads: 'the scheme dispute history interface',
    probe: partitionProbe(
      'prior_dispute_record',
      6,
      {
        prior_dispute_with_merchant: [DISPUTE, FREEZE],
        no_prior_dispute: [RECEIPT, NOTE, CALLBACK],
      },
      'Has this account disputed this merchant before?',
    ),
    run: ({ snapshot, cardId }) => {
      const focus = focalTransaction(snapshot, cardId);
      if (!focus) return { observation: 'no_prior_dispute', detail: 'no transaction to check' };

      const merchant = describeMerchant(snapshot, focus.merchantId);
      const prior = priorDisputesWith(snapshot, focus.merchantId);
      return prior.length > 0
        ? {
            observation: 'prior_dispute_with_merchant',
            detail: `${prior.length} earlier dispute(s) against ${merchant}, outcome ${prior[0]?.outcome}`,
          }
        : {
            observation: 'no_prior_dispute',
            detail: `no earlier dispute against ${merchant} from this account`,
          };
    },
  },
];

export function probeById(id: string): WorkflowProbe | undefined {
  return PROBES.find((entry) => entry.probe.id === id);
}

/** Just the `Probe` records, which is what `selectProbe` wants. */
export function probeCatalog(): readonly Probe[] {
  return PROBES.map((entry) => entry.probe);
}

/**
 * Fails the run if any probe costs as much as taking an action.
 *
 * Deliberately a hard failure rather than a warning. The contract's design
 * constraint is that probes must be cheaper than the action they inform, and a
 * constraint that only prints a warning is not one.
 */
export function assertProbesAreCheap(): void {
  const offenders = PROBES.filter((entry) => entry.probe.cost >= ACTION_COST);
  if (offenders.length > 0) {
    throw new Error(
      `probe(s) ${offenders.map((entry) => entry.probe.id).join(', ')} cost at least as much ` +
        `as acting (${ACTION_COST}). A probe that costs more than the action it informs is ` +
        'an argument for acting.',
    );
  }
}

/** Turns a probe result into the evidence record the next request carries. */
export function evidenceFrom(
  probe: WorkflowProbe,
  result: Observation,
  snapshot: AuthoritySnapshot,
): EvidenceRecord {
  return {
    probeId: probe.probe.id,
    observation: result.observation,
    detail: result.detail,
    source: probe.reads,
    readAt: snapshot.readAt,
  };
}
