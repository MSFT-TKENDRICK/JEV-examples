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
 * Snapshots are versioned because the version is load-bearing: a proposal is
 * approved against one version and revalidated against a fresh read, and the two
 * are allowed to differ. See `examples/fsi/07-next-step/approval.ts`.
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

/** Who is acting. Customer, agent and reviewer are never interchangeable. */
export type PrincipalRole = 'customer' | 'contact_centre_agent' | 'ops_reviewer';

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
 * compares it rather than assuming the world held still while a human decided.
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
}

/** Mutable seed state, written only by `applyOutOfBandChange`. */
interface AuthorityState {
  account: AccountRecord;
  cards: CardRecord[];
  transactions: TransactionRecord[];
  merchants: MerchantRecord[];
  cases: CaseRecord[];
  callbackSlots: CallbackSlot[];
}

export interface Authority {
  /** A fresh consistent read. Call it again rather than caching a snapshot. */
  read(): AuthoritySnapshot;
  /**
   * Simulates another channel changing the record between a proposal and its
   * execution — a second agent freezing the card, an issuer reversing a charge.
   * Bumps the version, which is what revalidation detects.
   */
  applyOutOfBandChange(note: string, change: (state: AuthorityState) => void): void;
  /** Human-readable log of out-of-band changes, for the run report. */
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
