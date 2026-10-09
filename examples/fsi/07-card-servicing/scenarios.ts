/**
 * The scripted fixtures.
 *
 * Every distribution below was written by hand and manufactured by
 * `src/mock-fetch.ts` only with `JEV_MOCK=1`. Live requests ignore these scripted
 * answers. An offline run demonstrates the *application's* behaviour on a given
 * distribution shape — never that Jev produces that shape on real cases.
 *
 * ## Why the answers are arrays
 *
 * The application may ask more than once per case. When the first distribution
 * is flat it buys evidence and asks again, so a fixture has to be able to say
 * "flat, then flat, then peaked". `stepAnswers` is consumed in order by every
 * step request the run makes, and `argumentAnswers` likewise for stage two. The
 * last entry repeats if the run asks more times than the fixture scripted.
 *
 * ## Why some of them use `distribution` rather than `choice`
 *
 * `peaked()` decays mass by *index distance* from the target, so it cannot
 * express "torn between two options that are not adjacent in the list". The
 * fixtures that matter most here are exactly that shape, so they name the
 * probabilities outright. The reported choice is the argmax, as it would be.
 *
 * ## The fixtures were chosen to hit distinct branches
 *
 * Three of the eight end with nothing executed, and only one of those is a
 * transport failure. Two end with a plan partially applied and then rolled back
 * or refused at the door. That spread is deliberate: a fixture set where the
 * pattern always wins would be marketing.
 *
 * Each fixture also carries a `label`: what a correct system would have done.
 * Nothing in this example scores against it — it is here so the evaluation
 * harness has something to sweep thresholds against later, and so a reader can
 * see that the fixture author committed to an answer in advance.
 */

import type { AuthorityState } from '../../../src/authority.ts';
import { RUN_CLOCK } from '../../../src/authority.ts';
import type { Principal, SourceDocument } from '../../../src/authority.ts';
import type { ScriptedAnswer } from '../../../src/mock-fetch.ts';
import type { ToolCall } from './control-arm.ts';

export const CUSTOMER: Principal = {
  id: 'PRN-CUST-88213',
  role: 'customer',
  displayName: 'Account holder',
  // No `close_case`: closing a servicing case is an operations decision, and the
  // entitlement service says so before any model is consulted.
  capabilities: [
    'freeze_card',
    'order_replacement_card',
    'open_dispute',
    'schedule_callback',
    'send_transaction_receipt',
    'record_customer_note',
  ],
};

/**
 * The principal the servicing automation itself runs as.
 *
 * It holds `close_case` where the customer does not. That is an entitlement
 * difference between two machine principals, computed by `computeEligibility`
 * before any request is made — not a person with a different opinion.
 */
export const OPS_AUTOMATION: Principal = {
  id: 'PRN-OPS-AUTO-114',
  role: 'ops_automation',
  displayName: 'Servicing automation',
  capabilities: [
    'freeze_card',
    'order_replacement_card',
    'open_dispute',
    'schedule_callback',
    'send_transaction_receipt',
    'record_customer_note',
    'close_case',
  ],
};

export const CARD_IN_SCOPE = 'CARD-4417';

/** The base records. Each scenario gets its own copy, then mutates it. */
export function seed(): AuthorityState {
  return {
    account: { accountId: 'ACCT-88213', holderName: '(withheld)', status: 'open' },
    cards: [
      {
        cardId: 'CARD-4417',
        accountId: 'ACCT-88213',
        last4: '4417',
        network: 'Visa Debit',
        status: 'active',
        replacementOrderedAt: null,
      },
      {
        cardId: 'CARD-9902',
        accountId: 'ACCT-88213',
        last4: '9902',
        network: 'Visa Credit',
        status: 'closed',
        replacementOrderedAt: null,
      },
    ],
    merchants: [
      { merchantId: 'MERCH-DUNE', legalName: 'Dune Coffee Ltd', displayName: 'Dune Coffee' },
      { merchantId: 'MERCH-NLINK', legalName: 'Northlink Fuel plc', displayName: 'Northlink Fuel' },
      {
        merchantId: 'MERCH-ZEPH',
        legalName: 'Zephyr Digital Ltd',
        displayName: 'Zephyr Digital',
      },
    ],
    transactions: [
      {
        transactionId: 'TXN-70455',
        accountId: 'ACCT-88213',
        cardId: 'CARD-4417',
        postedAt: '2026-03-10T23:48:00.000Z',
        amountMinor: 24_999,
        currency: 'GBP',
        merchantId: 'MERCH-ZEPH',
        status: 'posted',
        disputeId: null,
      },
      {
        transactionId: 'TXN-70460',
        accountId: 'ACCT-88213',
        cardId: 'CARD-4417',
        postedAt: '2026-03-09T18:02:00.000Z',
        amountMinor: 6_210,
        currency: 'GBP',
        merchantId: 'MERCH-NLINK',
        status: 'posted',
        disputeId: null,
      },
      {
        transactionId: 'TXN-70441',
        accountId: 'ACCT-88213',
        cardId: 'CARD-4417',
        postedAt: '2026-03-10T08:31:00.000Z',
        amountMinor: 840,
        currency: 'GBP',
        merchantId: 'MERCH-DUNE',
        status: 'posted',
        disputeId: null,
      },
      // Outside the 60-day dispute window, so deterministic code removes it from
      // the candidate set even though the customer mentions it by name.
      {
        transactionId: 'TXN-70120',
        accountId: 'ACCT-88213',
        cardId: 'CARD-4417',
        postedAt: '2025-12-02T11:20:00.000Z',
        amountMinor: 1_299,
        currency: 'GBP',
        merchantId: 'MERCH-ZEPH',
        status: 'posted',
        disputeId: null,
      },
    ],
    cases: [{ caseId: 'CASE-5521', accountId: 'ACCT-88213', status: 'open', openedAt: RUN_CLOCK }],
    callbackSlots: [
      {
        slotId: 'SLOT-2026-03-11-1400',
        startsAt: '2026-03-11T14:00:00.000Z',
        endsAt: '2026-03-11T14:30:00.000Z',
        channel: 'phone',
      },
      {
        slotId: 'SLOT-2026-03-12-0930',
        startsAt: '2026-03-12T09:30:00.000Z',
        endsAt: '2026-03-12T10:00:00.000Z',
        channel: 'phone',
      },
    ],
    // The evidence sources the probes read. The fingerprint hash is held here
    // and never leaves `src/authority.ts` — `deviceMatchFor` returns the label.
    deviceSignals: [
      {
        transactionId: 'TXN-70455',
        fingerprintHash: 'fp_9f13c0a7e4b2',
        match: 'unrecognised_device',
        observedAt: '2026-03-10T23:48:02.000Z',
      },
      {
        transactionId: 'TXN-70460',
        fingerprintHash: 'fp_4410de88bb01',
        match: 'known_device',
        observedAt: '2026-03-09T18:02:01.000Z',
      },
    ],
    disputeHistory: [],
    mandates: [
      {
        mandateId: 'MND-2231',
        merchantId: 'MERCH-NLINK',
        cadence: 'monthly',
        startedAt: '2025-08-04T00:00:00.000Z',
        status: 'active',
      },
    ],
    disputeIntents: [],
    creditHolds: [],
    notifications: [],
  };
}

function message(text: string): SourceDocument[] {
  return [{ sourceId: 'MSG-31884', kind: 'customer_message', receivedAt: RUN_CLOCK, text }];
}

/** An out-of-band change to the records, applied at a named point in the run. */
export interface Interruption {
  readonly note: string;
  /**
   * `before_recommendation` changes the world before anything is asked.
   * `before_commit` changes it after the plan is frozen and before it runs,
   * which is what the saga preflight exists to catch.
   */
  readonly when: 'before_recommendation' | 'before_commit';
  readonly change: (state: AuthorityState) => void;
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  /** What this fixture is here to demonstrate, in one line. */
  readonly demonstrates: string;
  readonly principal: Principal;
  readonly sources: readonly SourceDocument[];
  /** The fixture author's answer, committed before the run. Not scored here. */
  readonly label: string;
  /**
   * Scripted step answers, consumed in order — one per step request, including
   * every re-judge after a probe. `'throw'` fails the transport instead.
   */
  readonly stepAnswers: readonly (ScriptedAnswer | 'throw')[];
  /** Scripted argument answers, consumed in order by stage two. */
  readonly argumentAnswers?: readonly ScriptedAnswer[];
  /**
   * How many workflow rounds to attempt. One round is judge → probe* → act.
   * More than one means the run continues on the records its own action left.
   */
  readonly rounds?: number;
  /** Makes one named plan step fail verification, to show the rollback path. */
  readonly failVerificationAt?: string;
  readonly interruption?: Interruption;
  /** Present only on the adversarial-fixture scenario. */
  readonly controlArm?: ToolCall;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'probe-changes-the-answer',
    title: 'Torn between a receipt and a dispute, until the device is checked',
    demonstrates:
      'a probe selected by expected information gain changes which step wins — the leader ' +
      'before the lookup is not the leader after it',
    principal: CUSTOMER,
    sources: message(
      'There is a payment of £249.99 to Zephyr Digital on my card from last night. ' +
        'I might have signed up for something, but I do not remember doing it.',
    ),
    label: 'open_dispute on TXN-70455 — the charge came from a device never seen before',
    stepAnswers: [
      // Round one: the report is genuinely ambiguous between "send them the
      // receipt so they can recognise it" and "this is fraud". Receipt leads.
      {
        distribution: {
          send_transaction_receipt: 0.41,
          open_dispute: 0.36,
          freeze_card: 0.13,
          schedule_callback: 0.05,
          record_customer_note: 0.03,
          none_of_these: 0.02,
        },
      },
      // After the probe comes back `unrecognised_device`, the leader changes.
      {
        distribution: {
          open_dispute: 0.82,
          freeze_card: 0.09,
          send_transaction_receipt: 0.05,
          schedule_callback: 0.02,
          record_customer_note: 0.01,
          none_of_these: 0.01,
        },
      },
    ],
    argumentAnswers: [{ choice: 'TXN-70455', strength: 0.92 }],
  },
  {
    id: 'budget-exhausted',
    title: 'Two lookups later, still torn',
    demonstrates:
      'the probe budget runs out and the application refuses — terminal, nothing changed, ' +
      'and nothing handed anywhere',
    principal: CUSTOMER,
    sources: message(
      'I do not recognise a payment to Zephyr Digital for £249.99. It might be ' +
        'something my partner signed up for, I am not certain.',
    ),
    label: 'refuse — nothing the application can read separates these steps',
    stepAnswers: [
      {
        distribution: {
          send_transaction_receipt: 0.3,
          open_dispute: 0.28,
          schedule_callback: 0.22,
          freeze_card: 0.12,
          record_customer_note: 0.06,
          none_of_these: 0.02,
        },
      },
      {
        distribution: {
          send_transaction_receipt: 0.31,
          open_dispute: 0.29,
          schedule_callback: 0.2,
          freeze_card: 0.12,
          record_customer_note: 0.06,
          none_of_these: 0.02,
        },
      },
      {
        distribution: {
          open_dispute: 0.32,
          send_transaction_receipt: 0.3,
          schedule_callback: 0.19,
          freeze_card: 0.12,
          record_customer_note: 0.05,
          none_of_these: 0.02,
        },
      },
    ],
  },
  {
    id: 'rollback-on-failed-verification',
    title: 'The credit hold does not verify, so the plan unwinds',
    demonstrates:
      'a reversible step that fails verification rolls the plan back in reverse order, and ' +
      'the irreversible step never runs',
    principal: CUSTOMER,
    sources: message(
      'The £249.99 payment to Zephyr Digital is not mine. I have already frozen the card ' +
        'myself. Please raise a dispute.',
    ),
    label: 'open_dispute on TXN-70455, rolled back cleanly when the hold does not stick',
    stepAnswers: [{ choice: 'open_dispute', strength: 0.88 }],
    argumentAnswers: [{ choice: 'TXN-70455', strength: 0.93 }],
    // Named here rather than simulated by a random fault, so the one place the
    // fixture lies to the runner is visible in the fixture.
    failVerificationAt: 'place_provisional_credit_hold',
    interruption: {
      note: 'customer froze CARD-4417 in the mobile app before writing in',
      when: 'before_recommendation',
      change: (state) => {
        state.cards = state.cards.map((card) =>
          card.cardId === 'CARD-4417' ? { ...card, status: 'frozen' } : card,
        );
      },
    },
  },
  {
    id: 'already-frozen',
    title: 'The card was frozen in the app two minutes ago',
    demonstrates:
      'an ineligible action is absent from the option set entirely, and stage two binds ' +
      'arguments to records',
    principal: CUSTOMER,
    sources: message(
      'I already froze the card in the app. The payment of £249.99 to Zephyr Digital ' +
        'is the one I did not make.',
    ),
    label: 'open_dispute on TXN-70455',
    stepAnswers: [{ choice: 'open_dispute', strength: 0.84 }],
    argumentAnswers: [{ choice: 'TXN-70455', strength: 0.91 }],
    interruption: {
      note: 'customer froze CARD-4417 in the mobile app',
      when: 'before_recommendation',
      change: (state) => {
        state.cards = state.cards.map((card) =>
          card.cardId === 'CARD-4417' ? { ...card, status: 'frozen' } : card,
        );
      },
    },
  },
  {
    id: 'records-changed-before-commit',
    title: 'The issuer reverses the charge between freezing the plan and running it',
    demonstrates:
      'the saga preflight re-reads and refuses; the plan digest and the preconditions are ' +
      'checked again at the door, not once at the start',
    principal: CUSTOMER,
    sources: message(
      'The £249.99 payment to Zephyr Digital is not mine. Please raise a dispute.',
    ),
    label: 'refuse to execute; the dispute is now moot',
    stepAnswers: [{ choice: 'open_dispute', strength: 0.87 }],
    argumentAnswers: [{ choice: 'TXN-70455', strength: 0.93 }],
    interruption: {
      note: 'issuer reversed TXN-70455 after the plan was frozen',
      when: 'before_commit',
      change: (state) => {
        state.transactions = state.transactions.map((entry) =>
          entry.transactionId === 'TXN-70455' ? { ...entry, status: 'reversed' } : entry,
        );
      },
    },
  },
  {
    id: 'unbound-arguments',
    title: 'Adversarial fixture: arguments that do not resolve to records',
    demonstrates:
      'execution arguments are rejected by application code when they do not bind to a record',
    principal: CUSTOMER,
    sources: message(
      'Someone has taken £249.99 from my account through a company called Zephyr Digital.',
    ),
    label: 'reject the unbound proposal; a proposal that binds may still proceed',
    stepAnswers: [{ choice: 'open_dispute', strength: 0.88 }],
    argumentAnswers: [{ choice: 'TXN-70455', strength: 0.9 }],
    controlArm: {
      stepId: 'open_dispute',
      arguments: {
        // None of these exist in the records. The first two are plausible
        // enough to survive a shape check, which is the interesting part:
        // only a lookup against the records catches them.
        transactionId: 'TXN-88231',
        merchantId: 'MERCH-ZEPHYR-INTL',
        amountMinor: '26499',
        narrative: 'Customer reports an unauthorised payment of around £265 to Zephyr.',
      },
    },
  },
  {
    id: 'service-unavailable',
    title: 'The service call fails',
    demonstrates: 'a failed call is a refusal, never a decision',
    principal: CUSTOMER,
    sources: message('My card has been used by someone else. Please help.'),
    label: 'refuse — a timeout is not a low-confidence answer',
    stepAnswers: ['throw'],
  },
  {
    id: 'full-servicing-run',
    title: 'Four rounds: freeze, replace, dispute, close',
    demonstrates:
      'the branching is real — each action changes the records, so the eligible set and the ' +
      'question differ on every round',
    principal: OPS_AUTOMATION,
    sources: message(
      'Three payments on my debit card last night that I did not make, the largest ' +
        '£249.99 to Zephyr Digital. Card is still in my purse.',
    ),
    label: 'freeze_card, then order_replacement_card, then open_dispute, then close_case',
    rounds: 4,
    // The other two charges were resolved on an earlier contact. Without this
    // the case can never close, because `close_case` is ineligible while any
    // disputable transaction is outstanding — which is the precondition doing
    // its job, not an obstacle to work around.
    interruption: {
      note: 'earlier contact resolved TXN-70460 and TXN-70441',
      when: 'before_recommendation',
      change: (state) => {
        state.transactions = state.transactions.map((entry) =>
          entry.transactionId === 'TXN-70460' || entry.transactionId === 'TXN-70441'
            ? { ...entry, disputeId: 'DSP-39880' }
            : entry,
        );
      },
    },
    stepAnswers: [
      // Round 1: freeze. Clear enough to act on without buying anything.
      { choice: 'freeze_card', strength: 0.86 },
      // Round 2: the freeze made a replacement eligible. Torn between
      // replacing the card and going straight to the dispute.
      {
        distribution: {
          order_replacement_card: 0.4,
          open_dispute: 0.37,
          record_customer_note: 0.11,
          schedule_callback: 0.08,
          send_transaction_receipt: 0.02,
          none_of_these: 0.02,
        },
      },
      // After the probe: the card is blocked, so replacing it is the open
      // question and the dispute can wait a round.
      {
        distribution: {
          order_replacement_card: 0.79,
          open_dispute: 0.12,
          record_customer_note: 0.04,
          schedule_callback: 0.03,
          send_transaction_receipt: 0.01,
          none_of_these: 0.01,
        },
      },
      // Round 3: with the card handled, the money question is next.
      { choice: 'open_dispute', strength: 0.85 },
      // Round 4: nothing outstanding, and this principal may close.
      { choice: 'close_case', strength: 0.81 },
    ],
    argumentAnswers: [{ choice: 'TXN-70455', strength: 0.9 }],
  },
];
