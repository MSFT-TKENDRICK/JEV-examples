/**
 * The authoritative systems of record.
 *
 * ## Why this file exists at all
 *
 * The interesting property of example 07 is not what Jev answers. It is that
 * every fact Jev's answer is allowed to touch comes from here first: which cards
 * exist, which transactions exist, which merchant a transaction was actually
 * presented by, what the principal is entitled to do, and which callback slots
 * the scheduler is really offering.
 *
 * That ordering is the whole design. Deterministic code reads this module,
 * constructs a bounded option set from what it read, and only then consults a
 * model. An identifier that does not appear in a snapshot cannot be bound to an
 * execution argument, whatever produced it.
 *
 * ## What this module is not
 *
 * These are hand-written fixtures. They stand in for a card system of record, a
 * merchant directory, an entitlement service and a scheduler — four real
 * integrations with their own consistency, latency and availability problems.
 * Nothing here demonstrates that those integrations are easy, or that a real
 * deployment would have a single consistent read.
 *
 * Snapshots are versioned because the version is load-bearing: a plan is frozen
 * against one version and revalidated against a fresh read immediately before it
 * runs, and the two are allowed to differ. See
 * `examples/fsi/07-next-step/plan.ts`.
 *
 * ## The evidence sources
 *
 * Several records below exist to be *probed*: device signals, dispute history,
 * recurring mandates. They are what the application goes and looks up when the
 * distribution over next steps is flat — a read-only lookup against an
 * authoritative source, chosen by expected information gain, rather than a
 * question put to a person.
 *
 * They are ordinary records with ordinary lookups. Nothing about probing them is
 * clever; the interesting part is upstream, in what selects *which* one to read.
 */

/** What a principal is permitted to do, independent of any model. */
export type Capability =
  | 'freeze_card'
  | 'order_replacement_card'
  | 'open_dispute'
  | 'schedule_callback'
  | 'send_transaction_receipt'
  | 'record_customer_note'
  | 'close_case';

/**
 * Who is acting.
 *
 * `ops_automation` is the servicing automation's own entitlement, not a person
 * sitting behind a queue. It exists because some steps — closing a case — are
 * scoped to operations rather than to the customer, and that scoping is an
 * entitlement fact the entitlement service answers before any model runs.
 */
export type PrincipalRole = 'customer' | 'contact_centre_agent' | 'ops_automation';

export interface Principal {
  readonly id: string;
  readonly role: PrincipalRole;
  readonly displayName: string;
  /**
   * Computed by the entitlement service before any model is consulted. Jev is
   * never shown an action this set does not contain.
   */
  readonly capabilities: readonly Capability[];
}

export type CardStatus = 'active' | 'frozen' | 'closed';

export interface CardRecord {
  readonly cardId: string;
  readonly accountId: string;
  readonly last4: string;
  readonly network: string;
  readonly status: CardStatus;
  /** Set once a replacement has been ordered, so it cannot be ordered twice. */
  readonly replacementOrderedAt: string | null;
}

export type TransactionStatus = 'posted' | 'pending' | 'reversed';

export interface TransactionRecord {
  readonly transactionId: string;
  readonly accountId: string;
  readonly cardId: string;
  readonly postedAt: string;
  /** Minor units, because money is never a float. */
  readonly amountMinor: number;
  readonly currency: string;
  readonly merchantId: string;
  readonly status: TransactionStatus;
  /** Present once a dispute exists, so a second one cannot be opened. */
  readonly disputeId: string | null;
}

export interface MerchantRecord {
  readonly merchantId: string;
  readonly legalName: string;
  readonly displayName: string;
}

export interface CaseRecord {
  readonly caseId: string;
  readonly accountId: string;
  readonly status: 'open' | 'closed';
  readonly openedAt: string;
}

/** Offered by the scheduler. A model never invents an appointment time. */
export interface CallbackSlot {
  readonly slotId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly channel: 'phone' | 'secure_message';
}

export interface AccountRecord {
  readonly accountId: string;
  readonly holderName: string;
  readonly status: 'open' | 'restricted' | 'closed';
}

// ---------------------------------------------------------------------------
// Evidence records — the things a probe reads
// ---------------------------------------------------------------------------

/**
 * What the device service concluded, as a label.
 *
 * Deliberately not the fingerprint itself. `deviceFingerprint` is on the
 * withheld-fields list in `recommend.ts`, and probing must not quietly reopen
 * what minimization closed: the probe reads the raw signal inside this module
 * and returns one of three bounded labels. A derived label is still customer
 * data — it is just a great deal less of it than a device hash.
 */
export type DeviceMatch = 'known_device' | 'unrecognised_device' | 'no_signal';

export interface DeviceSignalRecord {
  readonly transactionId: string;
  /**
   * The raw signal. Never returned by any exported lookup, and never placed in
   * a request. Present so the fixture is honest about what the source holds.
   */
  readonly fingerprintHash: string;
  readonly match: DeviceMatch;
  readonly observedAt: string;
}

/** A dispute this account raised before, and how it ended. */
export interface DisputeHistoryRecord {
  readonly disputeId: string;
  readonly merchantId: string;
  readonly openedAt: string;
  readonly outcome: 'upheld' | 'rejected' | 'withdrawn';
}

/**
 * A standing instruction the customer set up with a merchant.
 *
 * This is the record that distinguishes "someone has my card" from "my partner
 * signed up for something" — which is exactly the pair a flat distribution over
 * `open_dispute` and `send_transaction_receipt` cannot separate on its own.
 */
export interface MandateRecord {
  readonly mandateId: string;
  readonly merchantId: string;
  readonly cadence: 'monthly' | 'annual';
  readonly startedAt: string;
  readonly status: 'active' | 'cancelled';
}

/** A dispute the harness opened during this run, before the scheme is involved. */
export interface DisputeIntentRecord {
  readonly caseId: string;
  readonly transactionId: string;
  readonly note: string;
}

/** A provisional credit hold, which is reversible until the chargeback is presented. */
export interface CreditHoldRecord {
  readonly holdId: string;
  readonly transactionId: string;
  readonly amountMinor: number;
  readonly status: 'held' | 'released';
}

/**
 * The customer's own words, kept verbatim.
 *
 * Genuinely authored content is routed away from Jev entirely. A dispute
 * narrative is the customer's text, quoted exactly — not a model's paraphrase of
 * it — because a paraphrase is a new assertion attributed to the customer.
 */
export interface SourceDocument {
  readonly sourceId: string;
  readonly kind: 'customer_message';
  readonly receivedAt: string;
  readonly text: string;
}

/**
 * One consistent read of every authoritative system, at a point in time.
 *
 * `version` changes whenever anything underneath changes. Application code
 * compares it rather than assuming the world held still between the read and
 * the write.
 */
export interface AuthoritySnapshot {
  readonly source: string;
  readonly version: string;
  readonly readAt: string;
  readonly account: AccountRecord;
  readonly cards: readonly CardRecord[];
  readonly transactions: readonly TransactionRecord[];
  readonly merchants: readonly MerchantRecord[];
  readonly cases: readonly CaseRecord[];
  readonly callbackSlots: readonly CallbackSlot[];
  readonly deviceSignals: readonly DeviceSignalRecord[];
  readonly disputeHistory: readonly DisputeHistoryRecord[];
  readonly mandates: readonly MandateRecord[];
  readonly disputeIntents: readonly DisputeIntentRecord[];
  readonly creditHolds: readonly CreditHoldRecord[];
  readonly notifications: readonly string[];
}

/** Mutable seed state, written only by `applyOutOfBandChange`. */
export interface AuthorityState {
  account: AccountRecord;
  cards: CardRecord[];
  transactions: TransactionRecord[];
  merchants: MerchantRecord[];
  cases: CaseRecord[];
  callbackSlots: CallbackSlot[];
  deviceSignals: DeviceSignalRecord[];
  disputeHistory: DisputeHistoryRecord[];
  mandates: MandateRecord[];
  disputeIntents: DisputeIntentRecord[];
  creditHolds: CreditHoldRecord[];
  notifications: string[];
}

export interface Authority {
  /** A fresh consistent read. Call it again rather than caching a snapshot. */
  read(): AuthoritySnapshot;
  /**
   * Simulates another channel changing the record between a plan being frozen
   * and its execution — a second agent freezing the card, an issuer reversing a
   * charge. Bumps the version, which is what the preflight detects.
   *
   * The harness's own steps write through this too, so an action the
   * application took is visible to the same fresh read as one it did not.
   */
  applyOutOfBandChange(note: string, change: (state: AuthorityState) => void): void;
  /** Plain-text log of out-of-band changes, for the run report. */
  changeLog(): readonly string[];
}

const SOURCE = 'card-system-of-record';

/** Fixed clock so a recorded run diffs cleanly against the next one. */
export const RUN_CLOCK = '2026-03-11T09:14:00.000Z';

export function createAuthority(seed: AuthorityState): Authority {
  const state = seed;
  const log: string[] = [];
  let revision = 1;

  return {
    read(): AuthoritySnapshot {
      return {
        source: SOURCE,
        version: `v${revision}`,
        readAt: RUN_CLOCK,
        account: state.account,
        cards: [...state.cards],
        transactions: [...state.transactions],
        merchants: [...state.merchants],
        cases: [...state.cases],
        callbackSlots: [...state.callbackSlots],
        deviceSignals: [...state.deviceSignals],
        disputeHistory: [...state.disputeHistory],
        mandates: [...state.mandates],
        disputeIntents: [...state.disputeIntents],
        creditHolds: [...state.creditHolds],
        notifications: [...state.notifications],
      };
    },
    applyOutOfBandChange(note, change) {
      change(state);
      revision += 1;
      log.push(`${note} (now ${SOURCE}@v${revision})`);
    },
    changeLog: () => [...log],
  };
}

// ---------------------------------------------------------------------------
// Lookups. Every one of these returns undefined rather than throwing, because
// "this identifier does not exist" is an ordinary, expected answer here.
// ---------------------------------------------------------------------------

export function findCard(snapshot: AuthoritySnapshot, cardId: string): CardRecord | undefined {
  return snapshot.cards.find((card) => card.cardId === cardId);
}

export function findTransaction(
  snapshot: AuthoritySnapshot,
  transactionId: string,
): TransactionRecord | undefined {
  return snapshot.transactions.find((entry) => entry.transactionId === transactionId);
}

export function findMerchant(
  snapshot: AuthoritySnapshot,
  merchantId: string,
): MerchantRecord | undefined {
  return snapshot.merchants.find((entry) => entry.merchantId === merchantId);
}

export function findCase(snapshot: AuthoritySnapshot, caseId: string): CaseRecord | undefined {
  return snapshot.cases.find((entry) => entry.caseId === caseId);
}

export function findCallbackSlot(
  snapshot: AuthoritySnapshot,
  slotId: string,
): CallbackSlot | undefined {
  return snapshot.callbackSlots.find((entry) => entry.slotId === slotId);
}

/** Authorization is a deterministic property of the principal, never a judgment. */
export function permits(principal: Principal, capability: Capability): boolean {
  return principal.capabilities.includes(capability);
}

/** Money, formatted for display only. */
export function formatAmount(amountMinor: number, currency: string): string {
  return `${(amountMinor / 100).toFixed(2)} ${currency}`;
}

export function describeMerchant(snapshot: AuthoritySnapshot, merchantId: string): string {
  return findMerchant(snapshot, merchantId)?.displayName ?? '(unknown merchant)';
}

// ---------------------------------------------------------------------------
// Evidence lookups — read-only, and the only way a probe touches the records
// ---------------------------------------------------------------------------

/**
 * What the device service says about the device that presented a transaction.
 *
 * Returns the label, never `fingerprintHash`. That asymmetry is the point: a
 * probe is allowed to learn "this was not a device we have seen" without the
 * device identifier itself entering a request, a ledger field or a log line.
 */
export function deviceMatchFor(
  snapshot: AuthoritySnapshot,
  transactionId: string,
): DeviceMatch {
  return (
    snapshot.deviceSignals.find((entry) => entry.transactionId === transactionId)?.match ??
    'no_signal'
  );
}

/** Disputes this account has raised against a merchant before. */
export function priorDisputesWith(
  snapshot: AuthoritySnapshot,
  merchantId: string,
): readonly DisputeHistoryRecord[] {
  return snapshot.disputeHistory.filter((entry) => entry.merchantId === merchantId);
}

/** A live standing instruction with a merchant, if one exists. */
export function activeMandateWith(
  snapshot: AuthoritySnapshot,
  merchantId: string,
): MandateRecord | undefined {
  return snapshot.mandates.find(
    (entry) => entry.merchantId === merchantId && entry.status === 'active',
  );
}

export interface VelocityReading {
  readonly count: number;
  readonly windowHours: number;
  /** True when the count exceeds what this card normally does in the window. */
  readonly burst: boolean;
}

/**
 * How many authorizations the card took in a recent window.
 *
 * The burst threshold is a fixture constant, like every other number in this
 * repository. A real velocity control is a modelled baseline per card, and
 * disagreeing with this one costs nothing.
 */
export function authorizationVelocity(
  snapshot: AuthoritySnapshot,
  cardId: string,
  windowHours = 24,
  burstThreshold = 3,
): VelocityReading {
  const now = Date.parse(snapshot.readAt);
  const count = snapshot.transactions.filter((entry) => {
    if (entry.cardId !== cardId) return false;
    const ageHours = (now - Date.parse(entry.postedAt)) / 3_600_000;
    return ageHours >= 0 && ageHours <= windowHours;
  }).length;

  return { count, windowHours, burst: count >= burstThreshold };
}

/** Posted transactions on a card, most recent first. */
export function transactionHistoryFor(
  snapshot: AuthoritySnapshot,
  cardId: string,
): readonly TransactionRecord[] {
  return snapshot.transactions
    .filter((entry) => entry.cardId === cardId)
    .slice()
    .sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));
}

/**
 * The transaction the customer's report is most plausibly about.
 *
 * Deterministic and deliberately dumb: the largest posted, undisputed
 * transaction on the card in scope. Several probes need *some* transaction to
 * read evidence about, and picking it by a rule keeps the probe's subject out
 * of the model's hands. It is not a claim that the largest charge is the one
 * the customer meant.
 */
export function focalTransaction(
  snapshot: AuthoritySnapshot,
  cardId: string,
): TransactionRecord | undefined {
  return transactionHistoryFor(snapshot, cardId)
    .filter((entry) => entry.status === 'posted' && entry.disputeId === null)
    .reduce<TransactionRecord | undefined>(
      (best, entry) => (best === undefined || entry.amountMinor > best.amountMinor ? entry : best),
      undefined,
    );
}

// ---------------------------------------------------------------------------
// Source spans
// ---------------------------------------------------------------------------

export interface SourceSpan {
  readonly sourceId: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Resolves a quoted string to an exact span of a permitted source document.
 *
 * Exact substring matching is deliberately strict. A near-quote is a rewrite,
 * and a rewritten customer statement is a new assertion nobody made. If the text
 * is not present character-for-character, there is no span and the caller
 * rejects it.
 */
export function resolveSpan(
  sources: readonly SourceDocument[],
  quoted: string,
): SourceSpan | undefined {
  for (const source of sources) {
    const start = source.text.indexOf(quoted);
    if (quoted.length > 0 && start !== -1) {
      return { sourceId: source.sourceId, start, end: start + quoted.length, text: quoted };
    }
  }
  return undefined;
}
