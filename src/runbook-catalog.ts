/**
 * The authoritative sources a batch operations bridge already has.
 *
 * ## Why this file exists at all
 *
 * The interesting design question in incident routing is not "what should the
 * model be asked?" but "what must the model never be asked?". A batch shop
 * already owns most of the answer in structured form: the scheduler knows the
 * dependency graph and which job abended first, the CMDB knows who owns a
 * configuration item, and the abend-code table is a mapping maintained by
 * humans. A model that rediscovers any of those is a model introducing error
 * into a place that previously had none.
 *
 * So this module is deliberately the *boring* half of example 08. Everything
 * here is a lookup. The catalog it exposes is also what bounds the Jev request:
 * candidate runbooks are derived from the affected configuration items **before**
 * the request is built, so an ineligible procedure is never offered as an option.
 *
 * ## What this file does not establish
 *
 * Nothing here is claimed to be complete or current. Real catalogs drift, real
 * CMDB ownership goes stale, and one of the fixtures in example 08 exists purely
 * because it does. A lookup table being deterministic makes it *auditable*, not
 * *right* — the difference matters, and this repo is not allowed to blur it.
 */

/** Versioned so a ledger record can be re-derived against the same snapshot. */
export const CATALOG_VERSION = '2026-09-19.3';
export const CMDB_SNAPSHOT_VERSION = '2026-09-22T02:15Z';
export const ABEND_TABLE_VERSION = '2026-08-30.1';

/** A configuration item — the unit the CMDB, the scheduler and paging agree on. */
export type ComponentId =
  | 'CBPOST'
  | 'CBSTMT'
  | 'GLEXTR'
  | 'CDCLR'
  | 'FXFEED'
  | 'MQ-CDCLR-CHL'
  | 'HSM-01'
  | 'DB2P01'
  | 'SCHED-PROD';

export interface CmdbRecord {
  component: ComponentId;
  description: string;
  /** The team accountable for the CI in the CMDB of record. */
  owner: string;
  /** Rota the alert pages, which is not always the accountable owner. */
  onCall: string;
  /**
   * Ownership quality, carried explicitly rather than assumed.
   *
   * `stale` and `conflicting` are not edge cases invented for a demo; an
   * eighteen-month-old CI record with a decommissioned owning team is the
   * ordinary state of a large estate. The routing code has to decide what to do
   * about it, and what it must not do is ask a model to guess the owner.
   */
  ownership: 'current' | 'stale' | 'conflicting';
  /** Populated when `ownership` is `conflicting`. */
  competingOwner?: string;
  /** Change-management state, used for precondition checks, never as a cause. */
  changeWindowOpen?: boolean;
}

export const CMDB: Readonly<Record<ComponentId, CmdbRecord>> = {
  CBPOST: {
    component: 'CBPOST',
    description: 'Core banking overnight posting (COBOL/DB2, flow NIGHTLY-CORE)',
    owner: 'core-banking-batch',
    onCall: 'core-banking-batch',
    ownership: 'current',
  },
  CBSTMT: {
    component: 'CBSTMT',
    description: 'Customer statement extract, successor of CBPOST',
    owner: 'core-banking-batch',
    onCall: 'core-banking-batch',
    ownership: 'current',
  },
  GLEXTR: {
    component: 'GLEXTR',
    description: 'General ledger extract and control-total reconciliation',
    owner: 'finance-systems',
    onCall: 'core-banking-batch',
    ownership: 'current',
  },
  CDCLR: {
    component: 'CDCLR',
    description: 'Card clearing interface to the scheme gateway',
    owner: 'cards-platform',
    onCall: 'cards-platform',
    ownership: 'current',
  },
  FXFEED: {
    component: 'FXFEED',
    description: 'Vendor FX rate feed, consumed by CBPOST and GLEXTR',
    owner: 'market-data',
    onCall: 'market-data',
    // The vendor feed changed hands in a reorganization and the CI was never
    // re-pointed. Two teams both believe they own it.
    ownership: 'conflicting',
    competingOwner: 'treasury-ops',
  },
  'MQ-CDCLR-CHL': {
    component: 'MQ-CDCLR-CHL',
    description: 'MQ sender channel CDCLR.TO.SCHEME',
    owner: 'middleware',
    onCall: 'middleware',
    ownership: 'current',
  },
  'HSM-01': {
    component: 'HSM-01',
    description: 'Payment HSM used for PIN and key operations',
    owner: 'payment-security',
    onCall: 'payment-security',
    ownership: 'current',
    changeWindowOpen: false,
  },
  DB2P01: {
    component: 'DB2P01',
    description: 'DB2 production subsystem backing the core banking tables',
    owner: 'database-services',
    onCall: 'database-services',
    // Last reviewed before the platform migration; retained as-is on purpose.
    ownership: 'stale',
  },
  'SCHED-PROD': {
    component: 'SCHED-PROD',
    description: 'Enterprise scheduler, production instance',
    owner: 'batch-scheduling',
    onCall: 'batch-scheduling',
    ownership: 'current',
  },
};

/**
 * A diagnostic procedure. Note what a runbook is here: the **first diagnostic
 * step** an engineer works through. It is not a remediation, not an owner, and
 * not a root cause. Choosing among applicable diagnostic procedures is the only
 * part of this workflow left genuinely semantic once the lookups have run.
 */
export interface Runbook {
  id: string;
  title: string;
  /** What the engineer does first, shown so the output is not an opaque code. */
  firstStep: string;
  /** CIs this procedure applies to. Used to bound the candidate set. */
  appliesTo: readonly ComponentId[];
  /**
   * Conditions that must hold in authoritative state for the procedure to be
   * actionable, revalidated by application code *after* a recommendation.
   */
  requires?: {
    /** Every listed CI must be in the incident's affected set. */
    components?: readonly ComponentId[];
    /** The named CI must have an open change window. */
    changeWindowOn?: ComponentId;
  };
}

export const RUNBOOKS: readonly Runbook[] = [
  {
    id: 'RB-DATA-0C7',
    title: 'Data exception in a packed-decimal field',
    firstStep: 'Identify the failing offset from the abend dump and the last record read.',
    appliesTo: ['CBPOST', 'CBSTMT', 'GLEXTR'],
  },
  {
    id: 'RB-SPACE-B37',
    title: 'Dataset space abend on an output generation',
    firstStep: 'Check the GDG base limit and the space parameters on the failing DD.',
    appliesTo: ['CBPOST', 'CBSTMT', 'GLEXTR', 'CDCLR'],
  },
  {
    id: 'RB-LOADLIB',
    title: 'Module not found or not loadable',
    firstStep: 'Compare the STEPLIB concatenation against the release manifest.',
    appliesTo: ['CBPOST', 'CBSTMT', 'GLEXTR', 'CDCLR'],
  },
  {
    id: 'RB-DB2-CONTENTION',
    title: 'DB2 lock escalation and -911 timeouts',
    firstStep: 'Pull the DB2 lock snapshot for the plan and identify the blocking thread.',
    appliesTo: ['DB2P01', 'CBPOST', 'CBSTMT', 'GLEXTR'],
  },
  {
    id: 'RB-FEED-LATE',
    title: 'Upstream vendor feed missing, short or superseded',
    firstStep: 'Confirm the expected generation arrived and compare its trailer count.',
    appliesTo: ['FXFEED', 'CBPOST', 'GLEXTR'],
  },
  {
    id: 'RB-CARD-SCHEME-CUTOVER',
    title: 'Scheme cutover-window arbitration failure',
    firstStep: 'Read the gateway arbitration log and confirm the active peer token.',
    appliesTo: ['CDCLR'],
  },
  {
    id: 'RB-MQ-CHANNEL',
    title: 'MQ channel stopped or in retry',
    firstStep: 'Display the channel status and the transmission queue depth.',
    appliesTo: ['MQ-CDCLR-CHL', 'CDCLR'],
  },
  {
    id: 'RB-HSM-KEYROT',
    title: 'HSM key rotation or key-check value mismatch',
    firstStep: 'Verify the key-check values against the rotation schedule.',
    appliesTo: ['HSM-01', 'CDCLR'],
    // Deliberately gated. A procedure that touches payment keys is not
    // actionable because a distribution pointed at it: the HSM must actually be
    // in the incident, and a rotation window must actually be open.
    requires: { components: ['HSM-01'], changeWindowOn: 'HSM-01' },
  },
  {
    id: 'RB-CTL-BREAK',
    title: 'Control-total break between posting and the general ledger',
    firstStep: 'Freeze downstream submission and reconcile the control file by record type.',
    appliesTo: ['GLEXTR', 'CBPOST'],
  },
];

/** The explicit escape hatch. Without it, the model is forced to be wrong. */
export const NONE_OPTION = 'none-of-these';

export const RUNBOOKS_BY_ID: ReadonlyMap<string, Runbook> = new Map(
  RUNBOOKS.map((runbook) => [runbook.id, runbook]),
);

/**
 * The human-maintained abend mapping.
 *
 * If a code is in this table, the model is never consulted about it. This is the
 * concrete form of "never ask a model what a lookup can determine".
 */
export const ABEND_RUNBOOKS: Readonly<Record<string, string>> = {
  S0C7: 'RB-DATA-0C7',
  SB37: 'RB-SPACE-B37',
  SE37: 'RB-SPACE-B37',
  B37: 'RB-SPACE-B37',
  S806: 'RB-LOADLIB',
  S913: 'RB-LOADLIB',
};

/**
 * Restart codes the scheduler handles by itself, with the attempt budget it is
 * allowed to spend before a human is involved.
 */
export const SCHEDULER_RESTARTABLE: Readonly<Record<string, number>> = {
  U0016: 3,
  S522: 2,
};

/**
 * Builds the candidate set for a Jev request from authoritative state.
 *
 * Two properties matter more than the implementation:
 *
 * 1. The set is derived from the incident's affected CIs, so a procedure that
 *    does not apply is never offered. That bounds the option space; it does not
 *    make any offered option correct.
 * 2. `none-of-these` is always appended. A candidate set that omits the true
 *    answer and offers no escape forces an error, and the error will still look
 *    like a confident one.
 */
export function candidateRunbooks(components: readonly ComponentId[]): Runbook[] {
  const affected = new Set(components);
  return RUNBOOKS.filter((runbook) => runbook.appliesTo.some((ci) => affected.has(ci)));
}

/** Choice criteria built from the candidate set, plus the escape hatch. */
export function candidateCriteria(candidates: readonly Runbook[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const runbook of candidates) {
    criteria[runbook.id] = `${runbook.title}. First step: ${runbook.firstStep}`;
  }
  criteria[NONE_OPTION] =
    'None of the listed procedures is the right first diagnostic step for this evidence.';
  return criteria;
}

export interface PreconditionResult {
  holds: boolean;
  /** Populated when `holds` is false. Stated as an authoritative-state fact. */
  reason?: string;
}

/**
 * Revalidates a recommended procedure against authoritative state.
 *
 * This runs *after* the model answers and is the reason the fallback does not
 * depend on the model being right. A sharply-peaked recommendation for a
 * procedure whose preconditions do not hold is refused here by ordinary code,
 * and the refusal is unaffected by how confident the distribution looked.
 */
export function preconditionsHold(
  runbook: Runbook,
  incidentComponents: readonly ComponentId[],
): PreconditionResult {
  const affected = new Set(incidentComponents);
  const required = runbook.requires;
  if (!required) return { holds: true };

  for (const component of required.components ?? []) {
    if (!affected.has(component)) {
      return { holds: false, reason: `${component} is not in the incident's affected CI set` };
    }
  }

  if (required.changeWindowOn) {
    const record = CMDB[required.changeWindowOn];
    if (!record.changeWindowOpen) {
      return {
        holds: false,
        reason: `no open change window on ${required.changeWindowOn} in the CMDB snapshot`,
      };
    }
  }

  return { holds: true };
}

/**
 * Resolves who the work goes to.
 *
 * Ownership is metadata, so it is read, never inferred. Every affected CI is
 * checked, not just the first: the contested record is frequently not the one
 * that happens to be listed first, and a note that never fires is worse than no
 * note at all.
 *
 * Where the metadata is stale or contested, that fact travels with the
 * assignment instead of being silently resolved — an operations bridge can act
 * on "two teams claim this CI", and cannot act on a guess that looks like a fact.
 */
export function assignment(components: readonly ComponentId[]): {
  team: string;
  notes: readonly string[];
} {
  const primary = components[0];
  if (!primary) return { team: 'batch-operations', notes: ['no affected CI recorded'] };

  const notes: string[] = [];
  for (const component of components) {
    const record = CMDB[component];
    if (record.ownership === 'conflicting') {
      notes.push(
        `${component}: CMDB ownership contested between ${record.owner} and ${record.competingOwner}; bridge confirms before handoff`,
      );
    } else if (record.ownership === 'stale') {
      notes.push(`${component}: CMDB record flagged stale; ownership unconfirmed`);
    }
  }

  return { team: CMDB[primary].owner, notes };
}
