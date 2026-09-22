/**
 * The authoritative sources a batch operations bridge already has, plus the two
 * catalogs example 08 is built around.
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
 * here is a lookup or a table.
 *
 * ## The two catalogs, and why they are separate
 *
 * **Remediations** (`RM-*`) change the world. They are the candidate set Jev
 * judges over, bounded by the incident's affected configuration items.
 *
 * **Diagnostics** (`DG-*`) only read. They are the probes. Each one declares
 * what it reads, what it costs, and how its possible observations partition the
 * remediation candidates.
 *
 * The separation is the whole design. A distribution over *remediations* is what
 * selects which *diagnostic* to run, because the value of a diagnostic is
 * defined by how much it would move that distribution. Collapse the two into one
 * catalog and the question degenerates into "which procedure looks likeliest",
 * which is a question a point estimate can pretend to answer.
 *
 * ## What this file does not establish
 *
 * Nothing here is claimed to be complete or current. Real catalogs drift, real
 * CMDB ownership goes stale, and one of the fixtures in example 08 exists purely
 * because it does. A lookup table being deterministic makes it *auditable*, not
 * *right* — the difference matters, and this repo is not allowed to blur it.
 *
 * And specifically: **the diagnostics below, their costs, and the way their
 * observations partition the remediations are all authored here.** They are not
 * drawn from any real site's procedures and the costs are not measured execution
 * times. The expected-information-gain arithmetic computed over them in
 * `src/information-gain.ts` is real arithmetic; its inputs are manufactured.
 */

import { partitionProbe } from './information-gain.ts';
import type { Probe } from './information-gain.ts';

/** Versioned so a ledger record can be re-derived against the same snapshot. */
export const CATALOG_VERSION = '2026-09-22.1';
export const CMDB_SNAPSHOT_VERSION = '2026-09-22T02:15Z';
export const ABEND_TABLE_VERSION = '2026-08-30.1';
export const FLOW_SNAPSHOT_VERSION = '2026-09-22T04:40Z';

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
  /**
   * Ownership quality, carried explicitly rather than assumed.
   *
   * `stale` and `conflicting` are not edge cases invented for a demo; an
   * eighteen-month-old CI record with a decommissioned owning team is the
   * ordinary state of a large estate. What this example does with that fact is
   * record it on the decision, because it is a known defect in the data the
   * program is reasoning over. It is not a reason to stop and find a person.
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
    ownership: 'current',
  },
  CBSTMT: {
    component: 'CBSTMT',
    description: 'Customer statement extract, successor of CBPOST',
    owner: 'core-banking-batch',
    ownership: 'current',
  },
  GLEXTR: {
    component: 'GLEXTR',
    description: 'General ledger extract and control-total reconciliation',
    owner: 'finance-systems',
    ownership: 'current',
  },
  CDCLR: {
    component: 'CDCLR',
    description: 'Card clearing interface to the scheme gateway',
    owner: 'cards-platform',
    ownership: 'current',
  },
  FXFEED: {
    component: 'FXFEED',
    description: 'Vendor FX rate feed, consumed by CBPOST and GLEXTR',
    owner: 'market-data',
    // The vendor feed changed hands in a reorganization and the CI was never
    // re-pointed. Two teams both believe they own it.
    ownership: 'conflicting',
    competingOwner: 'treasury-ops',
  },
  'MQ-CDCLR-CHL': {
    component: 'MQ-CDCLR-CHL',
    description: 'MQ sender channel CDCLR.TO.SCHEME',
    owner: 'middleware',
    ownership: 'current',
  },
  'HSM-01': {
    component: 'HSM-01',
    description: 'Payment HSM used for PIN and key operations',
    owner: 'payment-security',
    ownership: 'current',
    changeWindowOpen: false,
  },
  DB2P01: {
    component: 'DB2P01',
    description: 'DB2 production subsystem backing the core banking tables',
    owner: 'database-services',
    // Last confirmed before the platform migration; retained as-is on purpose.
    ownership: 'stale',
  },
  'SCHED-PROD': {
    component: 'SCHED-PROD',
    description: 'Enterprise scheduler, production instance',
    owner: 'batch-scheduling',
    ownership: 'current',
  },
};

// ---------------------------------------------------------------------------
// The scheduler's dependency graph.
// ---------------------------------------------------------------------------

/**
 * One job in a flow.
 *
 * This graph exists so that "the failure surfaced downstream of its cause" is a
 * thing the program can *discover* rather than a thing a fixture asserts. The
 * upstream diagnostic below walks it, which makes that one diagnostic's
 * observation genuinely computed from structured state instead of authored —
 * see `DIAGNOSTIC_OBSERVATION_SOURCE`.
 */
export interface FlowJob {
  job: string;
  flow: string;
  component: ComponentId;
  /** The job that must complete before this one runs, if any. */
  predecessor?: string;
  /** The scheduler's own terminal state for this job in the snapshot. */
  state: 'ENDED_OK' | 'ENDED_NOT_OK' | 'ABENDED' | 'WAITING_PREDECESSOR' | 'RESTART_PENDING';
  endedAt?: string;
}

/**
 * The snapshot of last night's window, as the scheduler holds it.
 *
 * `FXLOAD10` is the interesting entry: it finished `ENDED_NOT_OK` at 03:11,
 * twenty-three minutes before `CBPOST45` surfaced a DB2 timeout and an MQ
 * warning. Nothing paged on it, because a feed job that ends not-OK with an
 * empty generation is a warning in this shop rather than an abend.
 */
export const FLOW_SNAPSHOT: Readonly<Record<string, FlowJob>> = {
  FXLOAD10: {
    job: 'FXLOAD10',
    flow: 'NIGHTLY-CORE',
    component: 'FXFEED',
    state: 'ENDED_NOT_OK',
    endedAt: '2026-09-22T03:11:48Z',
  },
  CBPOST40: {
    job: 'CBPOST40',
    flow: 'NIGHTLY-CORE',
    component: 'CBPOST',
    state: 'ABENDED',
    endedAt: '2026-09-22T02:14:31Z',
  },
  CBPOST45: {
    job: 'CBPOST45',
    flow: 'NIGHTLY-CORE',
    component: 'CBPOST',
    predecessor: 'FXLOAD10',
    state: 'ENDED_NOT_OK',
    endedAt: '2026-09-22T03:34:12Z',
  },
  CBSTMT10: {
    job: 'CBSTMT10',
    flow: 'NIGHTLY-CORE',
    component: 'CBSTMT',
    predecessor: 'CBPOST40',
    state: 'WAITING_PREDECESSOR',
  },
  CBSTMT30: {
    job: 'CBSTMT30',
    flow: 'NIGHTLY-CORE',
    component: 'CBSTMT',
    predecessor: 'CBSTMT10',
    state: 'ENDED_NOT_OK',
    endedAt: '2026-09-22T04:31:22Z',
  },
  GLEXTR20: {
    job: 'GLEXTR20',
    flow: 'NIGHTLY-GL',
    component: 'GLEXTR',
    predecessor: 'CBPOST40',
    state: 'ABENDED',
    endedAt: '2026-09-22T02:41:55Z',
  },
  GLEXTR25: {
    job: 'GLEXTR25',
    flow: 'NIGHTLY-GL',
    component: 'GLEXTR',
    predecessor: 'GLEXTR20',
    state: 'ABENDED',
    endedAt: '2026-09-22T03:18:41Z',
  },
  GLEXTR30: {
    job: 'GLEXTR30',
    flow: 'NIGHTLY-GL',
    component: 'GLEXTR',
    predecessor: 'GLEXTR25',
    state: 'ENDED_NOT_OK',
    endedAt: '2026-09-22T03:07:44Z',
  },
  GLEXTR40: {
    job: 'GLEXTR40',
    flow: 'NIGHTLY-GL',
    component: 'GLEXTR',
    predecessor: 'GLEXTR30',
    state: 'ENDED_NOT_OK',
    endedAt: '2026-09-22T04:02:15Z',
  },
  CDCLR15: {
    job: 'CDCLR15',
    flow: 'NIGHTLY-CARDS',
    component: 'CDCLR',
    state: 'RESTART_PENDING',
  },
  CDCLR20: {
    job: 'CDCLR20',
    flow: 'NIGHTLY-CARDS',
    component: 'CDCLR',
    predecessor: 'CDCLR15',
    state: 'ENDED_NOT_OK',
    endedAt: '2026-09-22T03:21:38Z',
  },
  CDCLR30: {
    job: 'CDCLR30',
    flow: 'NIGHTLY-CARDS',
    component: 'CDCLR',
    predecessor: 'CDCLR20',
    state: 'ENDED_NOT_OK',
    endedAt: '2026-09-22T03:48:57Z',
  },
  CDCLR40: {
    job: 'CDCLR40',
    flow: 'NIGHTLY-CARDS',
    component: 'CDCLR',
    predecessor: 'CDCLR30',
    state: 'ENDED_NOT_OK',
    endedAt: '2026-09-22T04:19:03Z',
  },
};

const HEALTHY_STATES = new Set(['ENDED_OK', 'WAITING_PREDECESSOR']);

/**
 * Walks the predecessor chain backwards and returns the earliest job in it that
 * did not end cleanly.
 *
 * Read-only by construction: it takes a job name and returns a job. This is the
 * lookup the upstream diagnostic performs, and it is the reason that one
 * diagnostic's observation is computed rather than authored.
 */
export function earliestUnhealthyAncestor(job: string): FlowJob | null {
  const chain: FlowJob[] = [];
  let cursor: FlowJob | undefined = FLOW_SNAPSHOT[job];
  const visited = new Set<string>();

  while (cursor !== undefined && !visited.has(cursor.job)) {
    visited.add(cursor.job);
    chain.push(cursor);
    cursor = cursor.predecessor === undefined ? undefined : FLOW_SNAPSHOT[cursor.predecessor];
  }

  // Oldest first, so the *earliest* unhealthy job wins rather than the nearest.
  const unhealthy = chain.reverse().filter((entry) => !HEALTHY_STATES.has(entry.state));
  return unhealthy[0] ?? null;
}

// ---------------------------------------------------------------------------
// Remediations — the candidate set Jev judges over.
// ---------------------------------------------------------------------------

/**
 * One step of a remediation, in the form the act/verify/compensate runner needs.
 *
 * `reversible: false` marks the point of no return. `src/compensate.ts` refuses
 * any plan that schedules work after one, so the ordering guarantee is enforced
 * rather than documented.
 */
export interface RemediationStep {
  id: string;
  description: string;
  reversible: boolean;
  /** What verification reads back afterwards, stated as an observation. */
  verifies: string;
  /** How the step is undone. Meaningful only for reversible steps. */
  undo?: string;
}

export interface Remediation {
  id: string;
  title: string;
  /** CIs this procedure applies to. Used to bound the candidate set. */
  appliesTo: readonly ComponentId[];
  /** Ordered plan. The irreversible step, if any, must be last. */
  plan: readonly RemediationStep[];
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

export const REMEDIATIONS: readonly Remediation[] = [
  {
    id: 'RM-DATA-0C7',
    title: 'Quarantine the rejected records and reprocess the posting batch',
    appliesTo: ['CBPOST', 'CBSTMT', 'GLEXTR'],
    plan: [
      {
        id: 'quarantine-rejects',
        description: 'Copy the reject file to the quarantine generation',
        reversible: true,
        verifies: 'quarantine generation exists with the expected record count',
        undo: 'delete the quarantine generation',
      },
      {
        id: 'resubmit-batch',
        description: 'Resubmit the posting batch from the last committed unit of work',
        reversible: false,
        verifies: 'the batch reaches ENDED_OK and the posting cycle closes',
      },
    ],
  },
  {
    id: 'RM-SPACE-EXTEND',
    title: 'Extend the output generation and restart the failing step',
    appliesTo: ['CBPOST', 'CBSTMT', 'GLEXTR', 'CDCLR'],
    plan: [
      {
        id: 'raise-gdg-limit',
        description: 'Raise the GDG base limit and the secondary space allocation',
        reversible: true,
        verifies: 'the catalog reports the new limit',
        undo: 'restore the previous GDG base limit',
      },
      {
        id: 'restart-step',
        description: 'Restart the failing step from its checkpoint',
        reversible: false,
        verifies: 'the step completes and writes the expected generation',
      },
    ],
  },
  {
    id: 'RM-LOADLIB-REPOINT',
    title: 'Repoint the STEPLIB concatenation at the release manifest and restart',
    appliesTo: ['CBPOST', 'CBSTMT', 'GLEXTR', 'CDCLR'],
    plan: [
      {
        id: 'stage-concatenation',
        description: 'Stage the manifest concatenation in the override library',
        reversible: true,
        verifies: 'the override library resolves every module in the manifest',
        undo: 'clear the override library',
      },
      {
        id: 'restart-job',
        description: 'Restart the job against the staged concatenation',
        reversible: false,
        verifies: 'the job loads the expected module and completes',
      },
    ],
  },
  {
    id: 'RM-DB2-RELIEVE-LOCK',
    title: 'Cancel the blocking thread and restart the failing unit of work',
    appliesTo: ['DB2P01', 'CBPOST', 'CBSTMT', 'GLEXTR'],
    plan: [
      {
        id: 'snapshot-locks',
        description: 'Attach the lock snapshot to the incident record',
        reversible: true,
        verifies: 'the snapshot is attached and names a blocking thread',
        undo: 'detach the snapshot from the incident record',
      },
      {
        id: 'cancel-thread',
        description: 'Cancel the blocking thread',
        reversible: true,
        verifies: 'the thread is gone and the lock wait count has dropped',
        undo: 'nothing to restore; the cancelled thread rolled itself back',
      },
      {
        id: 'restart-uow',
        description: 'Restart the failing unit of work',
        reversible: false,
        verifies: 'the unit of work commits',
      },
    ],
  },
  {
    id: 'RM-FEED-RESUPPLY',
    title: 'Request the vendor generation again and re-run the dependent step',
    appliesTo: ['FXFEED', 'CBPOST', 'GLEXTR'],
    plan: [
      {
        id: 'hold-dependents',
        description: 'Hold the dependent jobs in the scheduler',
        reversible: true,
        verifies: 'the dependent jobs report HELD',
        undo: 'release the dependent jobs',
      },
      {
        id: 'request-resupply',
        description: 'Request the missing generation from the vendor transfer service',
        reversible: true,
        verifies: 'the generation lands with a non-zero trailer count',
        undo: 'cancel the transfer request and delete the partial generation',
      },
      {
        id: 'release-dependents',
        description: 'Release the dependent jobs against the new generation',
        reversible: false,
        verifies: 'the dependent step reads the expected rate count',
      },
    ],
  },
  {
    id: 'RM-SCHEME-REARBITRATE',
    title: 'Re-arbitrate the scheme cutover window and reopen the session',
    appliesTo: ['CDCLR'],
    plan: [
      {
        id: 'quiesce-session',
        description: 'Quiesce the local scheme session',
        reversible: true,
        verifies: 'the local window reports QUIESCED',
        undo: 'resume the local scheme session',
      },
      {
        id: 'reissue-token',
        description: 'Reissue the arbitration token against the peer gateway',
        reversible: true,
        verifies: 'the peer acknowledges the new token sequence',
        undo: 'revoke the reissued token',
      },
      {
        id: 'reopen-session',
        description: 'Reopen the session on the next cutover window',
        reversible: false,
        verifies: 'the session opens and clears its backlog',
      },
    ],
  },
  {
    id: 'RM-MQ-RESTART-CHANNEL',
    title: 'Restart the sender channel and drain the transmission queue',
    appliesTo: ['MQ-CDCLR-CHL', 'CDCLR'],
    plan: [
      {
        id: 'record-depth',
        description: 'Record the current transmission queue depth on the incident',
        reversible: true,
        verifies: 'the depth is recorded',
        undo: 'clear the recorded depth',
      },
      {
        id: 'restart-channel',
        description: 'Stop and restart the sender channel',
        reversible: true,
        verifies: 'the channel reports RUNNING and the queue depth is falling',
        undo: 'stop the channel and restore its previous disposition',
      },
    ],
  },
  {
    id: 'RM-HSM-KEYSYNC',
    title: 'Resynchronise the card key set against the rotation schedule',
    appliesTo: ['HSM-01', 'CDCLR'],
    // Deliberately gated. A procedure that touches payment keys is not
    // actionable because a distribution pointed at it: the HSM must actually be
    // in the incident, and a rotation window must actually be open.
    requires: { components: ['HSM-01'], changeWindowOn: 'HSM-01' },
    plan: [
      {
        id: 'export-kcv',
        description: 'Capture the current key-check values for the affected key set',
        reversible: true,
        verifies: 'the key-check values are captured',
        undo: 'discard the captured key-check values',
      },
      {
        id: 'activate-scheduled-key',
        description: 'Activate the scheduled key version',
        reversible: false,
        verifies: 'PIN verification succeeds against the new key version',
      },
    ],
  },
  {
    id: 'RM-CTL-REBUILD',
    title: 'Rebuild the control file by record type and resubmit the extract',
    appliesTo: ['GLEXTR', 'CBPOST'],
    plan: [
      {
        id: 'freeze-submission',
        description: 'Freeze downstream submission',
        reversible: true,
        verifies: 'downstream submission reports FROZEN',
        undo: 'unfreeze downstream submission',
      },
      {
        id: 'rebuild-control',
        description: 'Rebuild the control file by record type',
        reversible: true,
        verifies: 'the rebuilt control totals match the posting totals',
        undo: 'restore the previous control file generation',
      },
      {
        id: 'resubmit-extract',
        description: 'Resubmit the ledger extract',
        reversible: false,
        verifies: 'the extract completes and the control totals balance',
      },
    ],
  },
];

/** The explicit escape hatch. Without it, the model is forced to be wrong. */
export const NONE_OPTION = 'none-of-these';

export const REMEDIATIONS_BY_ID: ReadonlyMap<string, Remediation> = new Map(
  REMEDIATIONS.map((remediation) => [remediation.id, remediation]),
);

// ---------------------------------------------------------------------------
// Diagnostics — the probes.
// ---------------------------------------------------------------------------

/**
 * A read-only diagnostic procedure.
 *
 * Three properties are load-bearing and all three are authored here:
 *
 * - `costUnits` — an abstract budget unit. **Not minutes.** Nothing in this repo
 *   measured anything; the numbers exist so that ranking by gain-per-cost has
 *   something to rank.
 * - `partition` — which remediations each possible observation is consistent
 *   with. A remediation absent from every bucket is treated as uninformative for
 *   this diagnostic rather than impossible, so an omission weakens the probe
 *   instead of silently zeroing a candidate.
 * - `observations` — derived from `partition`, so the two cannot drift apart.
 *
 * `reads` is prose, and it is the honest label on the read-only claim: these
 * procedures are read-only because they are *described* as reads and the example
 * never gives them a way to write. That is a property of the fixture, not a
 * property enforced by a sandbox.
 */
export interface Diagnostic {
  id: string;
  title: string;
  /** The read-only source it consults. */
  reads: string;
  costUnits: number;
  appliesTo: readonly ComponentId[];
  /** Observation → remediation ids consistent with it. */
  partition: Readonly<Record<string, readonly string[]>>;
}

export const DIAGNOSTICS: readonly Diagnostic[] = [
  {
    id: 'DG-UPSTREAM-DEPGRAPH',
    title: 'Find the earliest job in the flow that did not end cleanly',
    reads: "the scheduler's dependency graph and last night's job states",
    // The cheapest thing in the shop: the scheduler already holds this and
    // answering it touches nothing.
    costUnits: 1,
    appliesTo: ['CBPOST', 'CBSTMT', 'GLEXTR', 'CDCLR', 'FXFEED', 'SCHED-PROD', 'DB2P01'],
    partition: {
      'first-failure-is-this-job': [
        'RM-DATA-0C7',
        'RM-SPACE-EXTEND',
        'RM-LOADLIB-REPOINT',
        'RM-DB2-RELIEVE-LOCK',
        'RM-SCHEME-REARBITRATE',
        'RM-MQ-RESTART-CHANNEL',
        'RM-HSM-KEYSYNC',
      ],
      'first-failure-upstream-feed': ['RM-FEED-RESUPPLY'],
      'first-failure-upstream-posting': ['RM-CTL-REBUILD', 'RM-DATA-0C7'],
      'first-failure-upstream-other': ['RM-DB2-RELIEVE-LOCK', 'RM-MQ-RESTART-CHANNEL'],
    },
  },
  {
    id: 'DG-MQ-CHANSTAT',
    title: 'Display the sender channel status and transmission queue depth',
    reads: 'the queue manager command server',
    costUnits: 1,
    appliesTo: ['MQ-CDCLR-CHL', 'CDCLR'],
    partition: {
      'channel-retrying': ['RM-MQ-RESTART-CHANNEL'],
      'channel-running': [
        'RM-SCHEME-REARBITRATE',
        'RM-HSM-KEYSYNC',
        'RM-FEED-RESUPPLY',
        'RM-SPACE-EXTEND',
      ],
    },
  },
  {
    id: 'DG-FEED-TRAILER',
    title: 'Compare the vendor generation trailer count against the expected count',
    reads: 'the rate-feed catalog entry and its trailer record',
    costUnits: 2,
    appliesTo: ['FXFEED', 'CBPOST', 'GLEXTR', 'CDCLR'],
    partition: {
      'trailer-zero': ['RM-FEED-RESUPPLY'],
      'trailer-matches': [
        'RM-DATA-0C7',
        'RM-SPACE-EXTEND',
        'RM-LOADLIB-REPOINT',
        'RM-DB2-RELIEVE-LOCK',
        'RM-CTL-REBUILD',
        'RM-SCHEME-REARBITRATE',
        'RM-MQ-RESTART-CHANNEL',
        'RM-HSM-KEYSYNC',
      ],
    },
  },
  {
    id: 'DG-GDG-LIMIT',
    title: 'Read the GDG base limit and the space parameters on the failing DD',
    reads: 'the catalog and the job JCL',
    costUnits: 2,
    appliesTo: ['CBPOST', 'CBSTMT', 'GLEXTR', 'CDCLR'],
    partition: {
      'limit-reached': ['RM-SPACE-EXTEND'],
      'limit-headroom': [
        'RM-DATA-0C7',
        'RM-LOADLIB-REPOINT',
        'RM-DB2-RELIEVE-LOCK',
        'RM-FEED-RESUPPLY',
        'RM-CTL-REBUILD',
      ],
    },
  },
  {
    id: 'DG-LOADLIB-DIFF',
    title: 'Diff the STEPLIB concatenation against the release manifest',
    reads: 'the job JCL and the release manifest',
    costUnits: 2,
    appliesTo: ['CBPOST', 'CBSTMT', 'GLEXTR', 'CDCLR'],
    partition: {
      'module-missing': ['RM-LOADLIB-REPOINT'],
      'concatenation-matches': [
        'RM-DATA-0C7',
        'RM-SPACE-EXTEND',
        'RM-DB2-RELIEVE-LOCK',
        'RM-FEED-RESUPPLY',
        'RM-CTL-REBUILD',
      ],
    },
  },
  {
    id: 'DG-DB2-LOCKSNAP',
    title: 'Pull the DB2 lock snapshot for the plan and look for a blocking thread',
    reads: 'the DB2 display commands and the statistics trace',
    costUnits: 3,
    appliesTo: ['DB2P01', 'CBPOST', 'CBSTMT', 'GLEXTR'],
    partition: {
      'blocking-thread-present': ['RM-DB2-RELIEVE-LOCK'],
      'no-contention': [
        'RM-DATA-0C7',
        'RM-SPACE-EXTEND',
        'RM-LOADLIB-REPOINT',
        'RM-FEED-RESUPPLY',
        'RM-CTL-REBUILD',
      ],
    },
  },
  {
    id: 'DG-CTL-TOTALS',
    title: 'Reconcile the control file totals by record type without rebuilding',
    reads: 'the control file and the posting summary',
    costUnits: 3,
    appliesTo: ['GLEXTR', 'CBPOST'],
    partition: {
      'totals-break': ['RM-CTL-REBUILD'],
      'totals-balance': [
        'RM-DATA-0C7',
        'RM-SPACE-EXTEND',
        'RM-LOADLIB-REPOINT',
        'RM-DB2-RELIEVE-LOCK',
        'RM-FEED-RESUPPLY',
      ],
    },
  },
  {
    id: 'DG-SCHEME-ARBLOG',
    title: 'Read the scheme gateway arbitration log and confirm the active peer token',
    // Expensive on purpose: it needs an authenticated session against the
    // vendor portal, which is slow, rate-limited and audited.
    reads: 'the scheme vendor portal, via an audited read-only session',
    costUnits: 5,
    appliesTo: ['CDCLR'],
    partition: {
      'peer-token-stale': ['RM-SCHEME-REARBITRATE'],
      'peer-token-current': ['RM-MQ-RESTART-CHANNEL', 'RM-HSM-KEYSYNC', 'RM-SPACE-EXTEND'],
    },
  },
  {
    id: 'DG-ABEND-DUMP-TRACE',
    title: 'Restore the abend dump and trace the failing offset to a module and field',
    // The sharpest diagnostic in the catalog and nearly the most expensive:
    // restoring a dump from the spool archive is a bulk read and the trace is
    // manual. It is the entry that makes gain-per-cost differ from raw gain.
    reads: 'the spool archive and the load module cross-reference',
    costUnits: 6,
    appliesTo: ['CBPOST', 'CBSTMT', 'GLEXTR', 'CDCLR'],
    partition: {
      'offset-in-decimal-field': ['RM-DATA-0C7'],
      'offset-in-unresolved-module': ['RM-LOADLIB-REPOINT'],
      'offset-in-rate-lookup': ['RM-FEED-RESUPPLY'],
      'no-dump-available': [
        'RM-SPACE-EXTEND',
        'RM-DB2-RELIEVE-LOCK',
        'RM-CTL-REBUILD',
        'RM-MQ-RESTART-CHANNEL',
      ],
    },
  },
  {
    id: 'DG-HSM-KCV',
    title: 'Verify key-check values against the rotation schedule',
    // The most expensive entry, because a read against the HSM audit interface
    // needs a second operator present for its duration.
    reads: 'the HSM audit interface, under dual control',
    costUnits: 8,
    appliesTo: ['HSM-01', 'CDCLR'],
    partition: {
      'kcv-mismatch': ['RM-HSM-KEYSYNC'],
      'kcv-matches': ['RM-SCHEME-REARBITRATE', 'RM-MQ-RESTART-CHANNEL', 'RM-FEED-RESUPPLY'],
    },
  },
];

export const DIAGNOSTICS_BY_ID: ReadonlyMap<string, Diagnostic> = new Map(
  DIAGNOSTICS.map((diagnostic) => [diagnostic.id, diagnostic]),
);

/**
 * Where each diagnostic's observation comes from when the example runs it.
 *
 * Exported because it is a disclosure, not an implementation detail. Exactly one
 * diagnostic computes its observation from structured state; every other
 * observation is a string written by the fixture author. A reader is entitled to
 * know which is which before drawing any conclusion from a probe trail.
 */
export const DIAGNOSTIC_OBSERVATION_SOURCE: Readonly<Record<string, 'computed' | 'authored'>> = {
  'DG-UPSTREAM-DEPGRAPH': 'computed',
  'DG-MQ-CHANSTAT': 'authored',
  'DG-FEED-TRAILER': 'authored',
  'DG-GDG-LIMIT': 'authored',
  'DG-LOADLIB-DIFF': 'authored',
  'DG-DB2-LOCKSNAP': 'authored',
  'DG-CTL-TOTALS': 'authored',
  'DG-SCHEME-ARBLOG': 'authored',
  'DG-ABEND-DUMP-TRACE': 'authored',
  'DG-HSM-KCV': 'authored',
};

// ---------------------------------------------------------------------------
// The human-maintained lookups.
// ---------------------------------------------------------------------------

/**
 * The human-maintained abend mapping, from code straight to remediation.
 *
 * If a code is in this table, the model is never consulted about it and no
 * diagnostic is run. This is the concrete form of "never ask a model what a
 * lookup can determine", and it is also why the residual is genuinely hard: the
 * easy half has already been removed.
 */
export const ABEND_RUNBOOKS: Readonly<Record<string, string>> = {
  S0C7: 'RM-DATA-0C7',
  SB37: 'RM-SPACE-EXTEND',
  SE37: 'RM-SPACE-EXTEND',
  B37: 'RM-SPACE-EXTEND',
  S806: 'RM-LOADLIB-REPOINT',
  S913: 'RM-LOADLIB-REPOINT',
};

/** Restart codes the scheduler handles by itself, with its own attempt budget. */
export const SCHEDULER_RESTARTABLE: Readonly<Record<string, number>> = {
  U0016: 3,
  S522: 2,
};

// ---------------------------------------------------------------------------
// Bounding the request, and revalidating the answer.
// ---------------------------------------------------------------------------

/**
 * Builds the candidate set for a Jev request from authoritative state.
 *
 * Two properties matter more than the implementation:
 *
 * 1. The set is derived from the incident's affected CIs, so a procedure that
 *    does not apply is never offered. That bounds the option space; it does not
 *    make any offered option correct.
 * 2. `none-of-these` is always appended by `candidateCriteria`. A candidate set
 *    that omits the true answer and offers no escape forces an error, and the
 *    error will still look like a confident one.
 */
export function candidateRemediations(components: readonly ComponentId[]): Remediation[] {
  const affected = new Set(components);
  return REMEDIATIONS.filter((remediation) => remediation.appliesTo.some((ci) => affected.has(ci)));
}

/** Choice criteria built from the candidate set, plus the escape hatch. */
export function candidateCriteria(candidates: readonly Remediation[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const remediation of candidates) {
    const first = remediation.plan[0];
    criteria[remediation.id] =
      `${remediation.title}. First step: ${first?.description ?? 'unspecified'}.`;
  }
  criteria[NONE_OPTION] =
    'None of the listed remediations addresses the condition described by this evidence.';
  return criteria;
}

/**
 * The diagnostics applicable to an incident, as probes over the candidate set.
 *
 * This is the bridge between the catalog and `src/information-gain.ts`: the
 * partition becomes a likelihood model, the cost becomes the denominator of
 * `gainPerCost`, and `selectProbe` does the rest. Nothing about which diagnostic
 * gets chosen is written down anywhere — it falls out of the prior.
 */
export function diagnosticProbes(components: readonly ComponentId[]): Probe[] {
  const affected = new Set(components);
  return DIAGNOSTICS.filter((diagnostic) => diagnostic.appliesTo.some((ci) => affected.has(ci))).map(
    (diagnostic) =>
      partitionProbe(diagnostic.id, diagnostic.costUnits, diagnostic.partition, diagnostic.title),
  );
}

export interface PreconditionResult {
  holds: boolean;
  /** Populated when `holds` is false. Stated as an authoritative-state fact. */
  reason?: string;
}

/**
 * Revalidates a recommended remediation against authoritative state.
 *
 * This runs *after* the model answers and is the reason the safe path does not
 * depend on the model being right. A sharply-peaked recommendation for a
 * procedure whose preconditions do not hold is refused here by ordinary code,
 * and the refusal is unaffected by how confident the distribution looked.
 */
export function preconditionsHold(
  remediation: Remediation,
  incidentComponents: readonly ComponentId[],
): PreconditionResult {
  const affected = new Set(incidentComponents);
  const required = remediation.requires;
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
 * Known defects in the ownership metadata for an incident's CIs.
 *
 * These notes are recorded on the decision and printed. They are **not** a
 * route: nothing in this example stops and waits because a CMDB record is
 * stale. Ownership is metadata the program reasons over, and a known-bad field
 * is worth recording precisely so a later reader can tell which parts of the
 * record to distrust.
 */
export function ownershipNotes(components: readonly ComponentId[]): string[] {
  const notes: string[] = [];
  for (const component of components) {
    const record = CMDB[component];
    if (record.ownership === 'conflicting') {
      notes.push(
        `${component}: CMDB ownership contested between ${record.owner} and ` +
          `${record.competingOwner ?? 'an unrecorded second team'} — recorded, not resolved`,
      );
    } else if (record.ownership === 'stale') {
      notes.push(`${component}: CMDB record flagged stale; the owner field is not trustworthy`);
    }
  }
  return notes;
}
