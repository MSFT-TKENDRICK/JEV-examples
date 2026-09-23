/**
 * Incident fixtures for example 08.
 *
 * Sixteen incidents from one overnight batch window. They are shaped to make two
 * things visible.
 *
 * **Most incidents in a batch shop are answered by lookups.** Seven of these are
 * settled by the scheduler, the incident system, the reconciliation control or
 * the abend table, and no request is built for them at all.
 *
 * **What is left is not "harder tickets" — it is structurally different work.**
 * An unfamiliar vendor message; a cluster of low-level errors that may all be
 * consequences of one upstream job that nobody paged on; a condition the catalog
 * does not cover; a remediation that undoes itself when verification fails.
 *
 * ## What is scripted, and what is not
 *
 * The incidents, spool text, and — with exactly one exception — diagnostic
 * observations are manufactured in both modes. Model answers and distributions
 * below are used only with `JEV_MOCK=1`; live requests ignore them.
 *
 * The exception is `DG-UPSTREAM-DEPGRAPH`, which computes its observation by
 * walking `FLOW_SNAPSHOT` in `src/runbook-catalog.ts`. That one is a real
 * traversal of structured state. Every other observation below is a string
 * chosen by the author, and `DIAGNOSTIC_OBSERVATION_SOURCE` records which is
 * which so nobody has to take this paragraph's word for it.
 *
 * Two fixtures exist specifically because the design has to survive being wrong:
 *
 * - `INC-4480` is scripted **confident and wrong** — 91% of the mass on a
 *   key-management remediation whose preconditions authoritative state does not
 *   satisfy. No threshold on a peaked distribution produces a refusal; ordinary
 *   code has to.
 * - `INC-4485` is scripted so that a reversible step **fails its verification**,
 *   because a remediation runner that only ever succeeds has demonstrated
 *   nothing about rollback.
 */

import type { ComponentId } from '../../../src/runbook-catalog.ts';

/** The scheduler's own view. Read, never inferred. */
export interface SchedulerState {
  state: 'ABENDED' | 'WAITING_PREDECESSOR' | 'RESTART_PENDING' | 'ENDED_NOT_OK';
  /** Populated when this job is held behind another job in the flow. */
  predecessor?: { job: string; state: string; incidentId?: string };
  /** Restart attempts already consumed, for scheduler-owned retries. */
  attempt?: number;
  /** Abend code the scheduler classifies as restartable. */
  restartCode?: string;
  /** Batch SLA the flow is working to, shown for operator context. */
  slaAt?: string;
}

/** Control-total evidence. A break here is a control matter, never a model matter. */
export interface Reconciliation {
  control: string;
  expectedItems: number;
  actualItems: number;
  expectedHashTotal: string;
  actualHashTotal: string;
}

/** Release correlation. Recorded, displayed, and explicitly not treated as cause. */
export interface ReleaseTrain {
  train: string;
  deployedAt: string;
  components: readonly ComponentId[];
}

/**
 * One scripted judgement.
 *
 * `rounds[0]` answers the first request. `rounds[n]` answers the request made
 * after `n` diagnostics have run, so a fixture can say "the model was torn, then
 * the upstream check came back and it was not torn any more". Running past the
 * end of the array reuses the last entry, which is how a fixture expresses "more
 * probing did not help".
 */
export interface ScriptedRound {
  /** Explicit mass per remediation id. Anything omitted gets none. */
  distribution: Readonly<Record<string, number>>;
  /** The model's own sufficiency answer, which is also a model output. */
  evidenceSufficient: number;
  /** Why this round looks the way it does. Not a claim about correctness. */
  note?: string;
}

export interface Incident {
  id: string;
  raisedAt: string;
  flow: string;
  job: string;
  step?: string;
  /** System or user abend code, when the job abended. */
  abendCode?: string;
  components: readonly ComponentId[];
  scheduler: SchedulerState;
  reconciliation?: Reconciliation;
  release?: ReleaseTrain;
  /** An open incident this one may duplicate, from the incident system. */
  possibleDuplicateOf?: { incidentId: string; job: string; abendCode?: string };
  /** Raw job log. Never sent as-is; `src/log-redact.ts` bounds and redacts it. */
  spool: readonly string[];
  /** Free text from the operations bridge, carried as untrusted input. */
  operatorNote?: string;
  /** Why this fixture exists. Not a claim about what the right answer is. */
  fixtureNote: string;
  /** Transport fault injected instead of a normal scripted response. */
  fault?: 'timeout' | 'malformed';
  /** Scripted judgements, indexed by how many diagnostics have already run. */
  rounds?: readonly ScriptedRound[];
  /**
   * What each diagnostic returns for this incident.
   *
   * Authored, with the single exception noted in this file's header. A
   * diagnostic with no entry here returns `inconclusive`, which is deliberately
   * *not* in any partition — so the Bayesian update falls back to the prior and
   * the probe is visibly recorded as having bought nothing.
   */
  observations?: Readonly<Record<string, string>>;
  /** Step id whose verification is scripted to fail during remediation. */
  failingStep?: string;
}

export const INCIDENTS: readonly Incident[] = [
  {
    id: 'INC-4471',
    raisedAt: '2026-09-22T02:14:03Z',
    flow: 'NIGHTLY-CORE',
    job: 'CBPOST40',
    step: 'STEP030',
    abendCode: 'S0C7',
    components: ['CBPOST', 'DB2P01'],
    scheduler: { state: 'ABENDED', slaAt: '2026-09-22T05:30Z' },
    release: {
      train: 'REL-2026.09.3',
      deployedAt: '2026-09-21T19:40Z',
      components: ['CBPOST'],
    },
    spool: [
      '02:11:04 JOB12871  IEF403I CBPOST40 - STARTED - TIME=02.11.04',
      '02:11:05 JOB12871  +CBP0100I POSTING CYCLE 20260922 BATCH 004 OPENED',
      '02:13:58 JOB12871  +CBP0180I 1,284,551 ITEMS READ FROM PROD.CB.POST.DAILY.GDG(+0)',
      '02:14:02 JOB12871  +CBP0221W REJECT WRITTEN ACCT=4416872301 PAN=5413 3300 8927 1145 RC=0008',
      '02:14:02 JOB12871  IEA995I SYMPTOM DUMP OUTPUT  SYSTEM COMPLETION CODE=0C7',
      '02:14:02 JOB12871  TIME=02.14.02 SEQ=01831 CPU=0000 ASID=00B4',
      '02:14:02 JOB12871  PSW AT TIME OF ERROR 078D1000 8AC3F1A2  ILC 6  INTC 07',
      '02:14:03 JOB12871  IEF472I CBPOST40 STEP030 - COMPLETION CODE - SYSTEM=0C7 USER=0000',
      '02:14:03 JOB12871  IEF450I CBPOST40 STEP030 - ABEND=S0C7 U0000 REASON=00000000',
      '02:14:05 JOB12871  +CBP0901I BACKOUT STARTED FOR UOW 0000004182',
      '02:14:31 JOB12871  +CBP0902I BACKOUT COMPLETE, 411 ROWS RESTORED',
      '02:14:31 JOB12871  IEF404I CBPOST40 - ENDED - TIME=02.14.31',
    ],
    fixtureNote:
      'Mapped abend code. The table answers it, so no request is built, no diagnostic runs and no model sees the spool.',
  },
  {
    id: 'INC-4472',
    raisedAt: '2026-09-22T02:16:10Z',
    flow: 'NIGHTLY-CORE',
    job: 'CBSTMT10',
    components: ['CBSTMT'],
    scheduler: {
      state: 'WAITING_PREDECESSOR',
      predecessor: { job: 'CBPOST40', state: 'ABENDED', incidentId: 'INC-4471' },
      slaAt: '2026-09-22T06:00Z',
    },
    spool: [
      '02:16:10 SCHED     CA7-3021 JOB CBSTMT10 HELD - PREDECESSOR CBPOST40 NOT COMPLETE',
      '02:16:10 SCHED     CA7-3022 REQUIREMENT OUTSTANDING: CBPOST40 COND CODE',
    ],
    fixtureNote:
      'Dependency state answers it. Opening a second investigation here splits the work across one failure.',
  },
  {
    id: 'INC-4473',
    raisedAt: '2026-09-22T02:41:55Z',
    flow: 'NIGHTLY-GL',
    job: 'GLEXTR20',
    step: 'STEP040',
    abendCode: 'SB37',
    components: ['GLEXTR'],
    scheduler: { state: 'ABENDED', slaAt: '2026-09-22T06:30Z' },
    spool: [
      '02:41:50 JOB12903  +GLX0410I WRITING PROD.GL.EXTRACT.DAILY.GDG(+1)',
      '02:41:54 JOB12903  IEC030I B37-04,IFG0554A,GLEXTR20,STEP040,OUTFILE',
      '02:41:55 JOB12903  IEF450I GLEXTR20 STEP040 - ABEND=SB37 U0000 REASON=00000004',
      '02:41:55 JOB12903  IEF472I GLEXTR20 STEP040 - COMPLETION CODE - SYSTEM=B37',
    ],
    fixtureNote: 'Space abend, mapped. Volume growth is an operations matter, not a semantic one.',
  },
  {
    id: 'INC-4474',
    raisedAt: '2026-09-22T02:52:19Z',
    flow: 'NIGHTLY-CARDS',
    job: 'CDCLR15',
    abendCode: 'U0016',
    components: ['CDCLR'],
    scheduler: {
      state: 'RESTART_PENDING',
      attempt: 1,
      restartCode: 'U0016',
      slaAt: '2026-09-22T05:00Z',
    },
    spool: [
      '02:52:18 JOB12940  +CDC0410W SCHEME SESSION RESET, RETRYABLE, RC=0016',
      '02:52:19 JOB12940  IEF450I CDCLR15 STEP010 - ABEND=U0016 REASON=00000000',
      '02:52:19 SCHED     CA7-4410 AUTO-RESTART SCHEDULED, ATTEMPT 1 OF 3',
    ],
    fixtureNote:
      'The scheduler already owns this. Consulting a model would duplicate its restart policy.',
  },
  {
    id: 'INC-4475',
    raisedAt: '2026-09-22T03:07:44Z',
    flow: 'NIGHTLY-GL',
    job: 'GLEXTR30',
    components: ['GLEXTR', 'CBPOST'],
    scheduler: { state: 'ENDED_NOT_OK', slaAt: '2026-09-22T06:30Z' },
    reconciliation: {
      control: 'GL-POST-DAILY',
      expectedItems: 1_284_551,
      actualItems: 1_284_504,
      expectedHashTotal: '418823771.44',
      actualHashTotal: '418791204.18',
    },
    spool: [
      '03:07:40 JOB12988  +GLX0700I CONTROL FILE PROD.GL.CONTROL.DAILY(+0) READ',
      '03:07:44 JOB12988  +GLX0791E CONTROL TOTAL MISMATCH - ITEMS EXPECTED 1284551 ACTUAL 1284504',
      '03:07:44 JOB12988  +GLX0792E HASH TOTAL MISMATCH - VARIANCE 32567.26',
      '03:07:44 JOB12988  IEF142I GLEXTR30 STEP060 - COND CODE 0012',
    ],
    fixtureNote:
      'A control break. Deterministic policy freezes downstream submission; there is nothing here to ask.',
  },
  {
    id: 'INC-4476',
    raisedAt: '2026-09-22T03:12:02Z',
    flow: 'NIGHTLY-CORE',
    job: 'CBPOST40',
    step: 'STEP030',
    abendCode: 'S0C7',
    components: ['CBPOST'],
    scheduler: { state: 'ABENDED' },
    possibleDuplicateOf: { incidentId: 'INC-4471', job: 'CBPOST40', abendCode: 'S0C7' },
    spool: ['03:12:02 MONITOR   ALERT REPEAT - CBPOST40 STEP030 ABEND S0C7 STILL OPEN'],
    fixtureNote:
      'Alert repeat during an open incident. Deduplication is a lookup on the incident system.',
  },
  {
    id: 'INC-4477',
    raisedAt: '2026-09-22T03:18:41Z',
    flow: 'NIGHTLY-GL',
    job: 'GLEXTR25',
    step: 'STEP010',
    abendCode: 'S806',
    components: ['GLEXTR'],
    scheduler: { state: 'ABENDED', slaAt: '2026-09-22T06:30Z' },
    release: {
      train: 'REL-2026.09.3',
      deployedAt: '2026-09-21T19:40Z',
      components: ['GLEXTR'],
    },
    spool: [
      '03:18:40 JOB13001  IEF403I GLEXTR25 - STARTED - TIME=03.18.40',
      '03:18:41 JOB13001  CSV003I REQUESTED MODULE GLX0440 NOT FOUND',
      '03:18:41 JOB13001  CSV028I ABEND806-04 JOBNAME=GLEXTR25 STEPNAME=STEP010',
      '03:18:41 JOB13001  IEF450I GLEXTR25 STEP010 - ABEND=S806 U0000 REASON=00000004',
    ],
    fixtureNote:
      'Mapped abend on a job in last night\u2019s release train. The mapping still answers it; the release is correlation and is not treated as cause.',
  },

  // --- Residual: what is left once the lookups have run. ---------------------

  {
    id: 'INC-4478',
    raisedAt: '2026-09-22T03:21:38Z',
    flow: 'NIGHTLY-CARDS',
    job: 'CDCLR20',
    components: ['CDCLR', 'MQ-CDCLR-CHL'],
    scheduler: { state: 'ENDED_NOT_OK', slaAt: '2026-09-22T05:00Z' },
    spool: [
      '03:21:30 JOB13004  +CDC0500I OPENING SCHEME SESSION, WINDOW 03 OF 04',
      '03:21:33 JOB13004  PLX0421E CUTOVER WINDOW ARBITRATION FAILED - PEER TOKEN STALE (SEQ 0)',
      '03:21:33 JOB13004  PLX0422I LOCAL WINDOW STATE=ACTIVE PEER WINDOW STATE=DRAINING',
      '03:21:35 JOB13004  AMQ9202W REMOTE HOST clr-gw-03.sch.internal.example NOT AVAILABLE, RETRYING',
      '03:21:36 JOB13004  +CDC0561W TRANSMISSION QUEUE DEPTH 4,118 AND RISING',
      '03:21:38 JOB13004  IEF142I CDCLR20 STEP020 - COND CODE 0008',
    ],
    operatorNote: 'Scheme desk says nothing declared on their side. Please advise first check.',
    fixtureNote:
      'The concentrated case. The first judgement is peaked enough that no diagnostic earns its cost, so the loop skips probing entirely and remediates. Included so the example is not only about being uncertain.',
    rounds: [
      {
        distribution: {
          'RM-SCHEME-REARBITRATE': 0.89,
          'RM-MQ-RESTART-CHANNEL': 0.05,
          'RM-SPACE-EXTEND': 0.02,
          'RM-LOADLIB-REPOINT': 0.02,
          'RM-HSM-KEYSYNC': 0.01,
          'none-of-these': 0.01,
        },
        evidenceSufficient: 0.84,
        note: 'peaked on first answer; leader clears the decision threshold',
      },
    ],
  },
  {
    id: 'INC-4479',
    raisedAt: '2026-09-22T03:34:12Z',
    flow: 'NIGHTLY-CORE',
    job: 'CBPOST45',
    components: ['CBPOST', 'DB2P01', 'FXFEED'],
    scheduler: { state: 'ENDED_NOT_OK', slaAt: '2026-09-22T05:30Z' },
    release: {
      train: 'REL-2026.09.3',
      deployedAt: '2026-09-21T19:40Z',
      components: ['CBPOST', 'GLEXTR'],
    },
    spool: [
      '03:33:51 JOB13052  +CBP0300I REVALUATION PASS STARTED FOR CYCLE 20260922',
      '03:33:58 JOB13052  +CBP0341W RATE SET PROD.FX.RATES.DAILY.GDG(+0) TRAILER COUNT 0',
      '03:34:02 JOB13052  DSNT408I SQLCODE = -911, ERROR: THE CURRENT UNIT OF WORK HAS BEEN ROLLED BACK',
      '03:34:02 JOB13052  DSNT418I SQLSTATE = 40001 SQLERRMC = 00C90088;00000302;CBPPLAN',
      '03:34:06 JOB13052  +CBP0352W RETRY 2 OF 3 ON CURSOR CBP_RATE_CUR',
      '03:34:09 JOB13052  AMQ9542W QUEUE MANAGER CLOSING, 812 MESSAGES UNCOMMITTED',
      '03:34:12 JOB13052  IEF142I CBPOST45 STEP020 - COND CODE 0008',
    ],
    operatorNote:
      'Three alerts inside a minute across posting, DB2 and MQ. Unclear whether this is one condition or three.',
    fixtureNote:
      'THE CASE THE EXAMPLE EXISTS FOR. The first judgement leads on the DB2 remediation. The cheapest diagnostic walks the scheduler graph and finds an upstream feed job that ended not-OK twenty-three minutes earlier and paged nobody. The re-judgement leads on the feed remediation instead. Probing changed the winner; it did not merely confirm it.',
    rounds: [
      {
        distribution: {
          'RM-DB2-RELIEVE-LOCK': 0.36,
          'RM-FEED-RESUPPLY': 0.27,
          'RM-CTL-REBUILD': 0.14,
          'RM-DATA-0C7': 0.1,
          'RM-LOADLIB-REPOINT': 0.07,
          'RM-SPACE-EXTEND': 0.04,
          'none-of-these': 0.02,
        },
        evidenceSufficient: 0.41,
        note: 'the -911 is the loudest line in the window, so the DB2 remediation leads',
      },
      {
        distribution: {
          'RM-FEED-RESUPPLY': 0.91,
          'RM-DB2-RELIEVE-LOCK': 0.04,
          'RM-CTL-REBUILD': 0.02,
          'RM-DATA-0C7': 0.01,
          'RM-LOADLIB-REPOINT': 0.01,
          'RM-SPACE-EXTEND': 0.005,
          'none-of-these': 0.005,
        },
        evidenceSufficient: 0.87,
        note: 'upstream feed job found; the DB2 timeout reads as a consequence rather than a cause',
      },
    ],
  },
  {
    id: 'INC-4484',
    raisedAt: '2026-09-22T03:41:07Z',
    flow: 'NIGHTLY-CORE',
    job: 'CBSTMT35',
    components: ['CBSTMT', 'DB2P01'],
    scheduler: { state: 'ENDED_NOT_OK', slaAt: '2026-09-22T06:00Z' },
    spool: [
      '03:40:58 JOB13066  +CBS0900I ARCHIVE PASS STARTED FOR CYCLE 20260922',
      '03:41:02 JOB13066  +CBS0931W SEGMENT 004 RETRY, REASON QUALIFIER 0x11',
      '03:41:04 JOB13066  DSNT408I SQLCODE = -904, ERROR: UNSUCCESSFUL EXECUTION CAUSED BY AN UNAVAILABLE RESOURCE',
      '03:41:05 JOB13066  +CBS0938W ARCHIVE SEGMENT INCOMPLETE, 62,004 OF 118,402 DOCUMENTS',
      '03:41:07 JOB13066  IEF142I CBSTMT35 STEP050 - COND CODE 0008',
    ],
    operatorNote:
      'Archive pass half finished. No abend, no control break, and the resource name in the -904 is not one we recognise.',
    fixtureNote:
      'The refusal case. Three diagnostics run, every one of them comes back negative, and the distribution never concentrates. Both budget dimensions are spent \u2014 three probes and all five cost units \u2014 so the run stops having changed nothing. This is a correct outcome, not a failure to reach one.',
    rounds: [
      {
        distribution: {
          'RM-DB2-RELIEVE-LOCK': 0.31,
          'RM-DATA-0C7': 0.28,
          'RM-LOADLIB-REPOINT': 0.22,
          'RM-SPACE-EXTEND': 0.16,
          'none-of-these': 0.03,
        },
        evidenceSufficient: 0.38,
      },
      {
        distribution: {
          'RM-DB2-RELIEVE-LOCK': 0.33,
          'RM-DATA-0C7': 0.3,
          'RM-LOADLIB-REPOINT': 0.21,
          'RM-SPACE-EXTEND': 0.13,
          'none-of-these': 0.03,
        },
        evidenceSufficient: 0.4,
        note: 'nothing upstream failed, so the trouble starts here \u2014 which rules nothing out, because every remaining candidate is a way for this job to fail on its own',
      },
      {
        distribution: {
          'RM-DB2-RELIEVE-LOCK': 0.4,
          'RM-DATA-0C7': 0.37,
          'RM-SPACE-EXTEND': 0.16,
          'RM-LOADLIB-REPOINT': 0.04,
          'none-of-these': 0.03,
        },
        evidenceSufficient: 0.44,
        note: 'the concatenation matches the manifest, which removes one candidate and sharpens nothing else',
      },
      {
        distribution: {
          'RM-DB2-RELIEVE-LOCK': 0.44,
          'RM-DATA-0C7': 0.41,
          'RM-SPACE-EXTEND': 0.05,
          'RM-LOADLIB-REPOINT': 0.04,
          'none-of-these': 0.06,
        },
        evidenceSufficient: 0.47,
        note: 'space has headroom too; two candidates remain live and nothing inside the budget separates them',
      },
    ],
    observations: {
      'DG-LOADLIB-DIFF': 'concatenation-matches',
      'DG-GDG-LIMIT': 'limit-headroom',
      'DG-DB2-LOCKSNAP': 'no-contention',
      'DG-ABEND-DUMP-TRACE': 'no-dump-available',
    },
  },
  {
    id: 'INC-4485',
    raisedAt: '2026-09-22T03:44:51Z',
    flow: 'NIGHTLY-CARDS',
    job: 'CDCLR25',
    components: ['CDCLR', 'MQ-CDCLR-CHL'],
    scheduler: { state: 'ENDED_NOT_OK', slaAt: '2026-09-22T05:00Z' },
    spool: [
      '03:44:44 JOB13078  +CDC0680I AUTHORISATION REPLAY STARTED, 9,204 ITEMS',
      '03:44:47 JOB13078  AMQ9513W MAXIMUM NUMBER OF CHANNELS REACHED ON CDCLR.TO.SCHEME',
      '03:44:49 JOB13078  AMQ9999E CHANNEL CDCLR.TO.SCHEME ENDED ABNORMALLY',
      '03:44:50 JOB13078  +CDC0688W REPLAY SUSPENDED, 2,610 ITEMS UNSENT',
      '03:44:51 JOB13078  IEF142I CDCLR25 STEP010 - COND CODE 0008',
    ],
    fixtureNote:
      'The rollback case. One cheap diagnostic concentrates the distribution, the remediation runs, and its second step fails verification. Both steps are reversible, so the runner undoes them in reverse order and reports rolled_back. Nothing here reaches a person.',
    rounds: [
      {
        distribution: {
          'RM-MQ-RESTART-CHANNEL': 0.51,
          'RM-SCHEME-REARBITRATE': 0.31,
          'RM-SPACE-EXTEND': 0.08,
          'RM-LOADLIB-REPOINT': 0.05,
          'RM-HSM-KEYSYNC': 0.03,
          'none-of-these': 0.02,
        },
        evidenceSufficient: 0.52,
      },
      {
        distribution: {
          'RM-MQ-RESTART-CHANNEL': 0.92,
          'RM-SCHEME-REARBITRATE': 0.04,
          'RM-SPACE-EXTEND': 0.015,
          'RM-LOADLIB-REPOINT': 0.01,
          'RM-HSM-KEYSYNC': 0.01,
          'none-of-these': 0.005,
        },
        evidenceSufficient: 0.9,
        note: 'channel confirmed retrying, which is consistent with exactly one remediation',
      },
    ],
    observations: {
      'DG-MQ-CHANSTAT': 'channel-retrying',
      'DG-SCHEME-ARBLOG': 'peer-token-current',
      'DG-HSM-KCV': 'kcv-matches',
    },
    failingStep: 'restart-channel',
  },
  {
    id: 'INC-4486',
    raisedAt: '2026-09-22T03:52:30Z',
    flow: 'NIGHTLY-GL',
    job: 'GLEXTR50',
    components: ['GLEXTR', 'CBPOST'],
    scheduler: { state: 'ENDED_NOT_OK', slaAt: '2026-09-22T06:30Z' },
    spool: [
      '03:52:20 JOB13084  +GLX0860I JOURNAL MERGE PASS STARTED',
      '03:52:24 JOB13084  DSNT408I SQLCODE = -911, ERROR: THE CURRENT UNIT OF WORK HAS BEEN ROLLED BACK',
      '03:52:26 JOB13084  +GLX0871W PACKED FIELD SUSPECT AT OFFSET 0x1C4 IN JOURNAL RECORD 44,102',
      '03:52:28 JOB13084  +GLX0879W MERGE ABANDONED AFTER 44,102 OF 902,118 RECORDS',
      '03:52:30 JOB13084  IEF142I GLEXTR50 STEP030 - COND CODE 0008',
    ],
    operatorNote:
      'Either a lock timeout or a bad packed field. The two readings suggest very different remediations.',
    fixtureNote:
      'The cost-efficiency case. The distribution is split almost evenly between a lock timeout and a bad packed field. The sharpest available diagnostic is the lock snapshot, which carries the highest raw expected gain of anything affordable — and it is not chosen first, because the dependency walk costs a third as much and would, if it found an upstream failure, remove both candidates at once. It does not find one. The expensive discriminator is then worth its price, and goes second. The ranked table prints raw gain and gain-per-cost side by side so the divergence is visible rather than asserted.',
    rounds: [
      {
        distribution: {
          'RM-DB2-RELIEVE-LOCK': 0.44,
          'RM-DATA-0C7': 0.41,
          'RM-CTL-REBUILD': 0.06,
          'RM-LOADLIB-REPOINT': 0.05,
          'RM-FEED-RESUPPLY': 0.02,
          'RM-SPACE-EXTEND': 0.01,
          'none-of-these': 0.01,
        },
        evidenceSufficient: 0.45,
      },
      {
        distribution: {
          'RM-DB2-RELIEVE-LOCK': 0.45,
          'RM-DATA-0C7': 0.42,
          'RM-LOADLIB-REPOINT': 0.07,
          'RM-SPACE-EXTEND': 0.02,
          'RM-CTL-REBUILD': 0.02,
          'RM-FEED-RESUPPLY': 0.01,
          'none-of-these': 0.01,
        },
        evidenceSufficient: 0.48,
        note: 'nothing upstream failed, so this job is where the trouble starts \u2014 which removes the upstream remediations and leaves the original two exactly as contested as before',
      },
      {
        distribution: {
          'RM-DB2-RELIEVE-LOCK': 0.9,
          'RM-DATA-0C7': 0.05,
          'RM-CTL-REBUILD': 0.02,
          'RM-LOADLIB-REPOINT': 0.015,
          'RM-FEED-RESUPPLY': 0.005,
          'RM-SPACE-EXTEND': 0.005,
          'none-of-these': 0.005,
        },
        evidenceSufficient: 0.88,
        note: 'a blocking thread is present, which the packed-field reading does not predict',
      },
    ],
    observations: {
      'DG-DB2-LOCKSNAP': 'blocking-thread-present',
      'DG-ABEND-DUMP-TRACE': 'offset-in-decimal-field',
      'DG-CTL-TOTALS': 'totals-balance',
      'DG-LOADLIB-DIFF': 'concatenation-matches',
      'DG-GDG-LIMIT': 'limit-headroom',
      'DG-FEED-TRAILER': 'trailer-matches',
    },
  },
  {
    id: 'INC-4480',
    raisedAt: '2026-09-22T03:48:57Z',
    flow: 'NIGHTLY-CARDS',
    job: 'CDCLR30',
    components: ['CDCLR', 'FXFEED'],
    scheduler: { state: 'ENDED_NOT_OK', slaAt: '2026-09-22T05:00Z' },
    spool: [
      '03:48:40 JOB13090  +CDC0620I SETTLEMENT PASS STARTED, 42,118 ITEMS',
      '03:48:44 JOB13090  +CDC0641E PIN VERIFY FAILED RC=68 KCV=A17F3C ON KEY SET 04',
      '03:48:47 JOB13090  +CDC0644W RATE LOOKUP FALLBACK USED, SOURCE PROD.FX.RATES.DAILY.GDG(+0) EMPTY',
      '03:48:52 JOB13090  +CDC0659E SETTLEMENT TOTALS UNAVAILABLE, DOWNSTREAM HELD',
      '03:48:57 JOB13090  IEF142I CDCLR30 STEP030 - COND CODE 0012',
    ],
    operatorNote:
      'Security desk believes the HSM is fine; market data thinks the rate file never landed. CMDB shows two owners for the feed.',
    fixtureNote:
      'Scripted CONFIDENTLY WRONG on purpose: high mass on a key-management remediation whose preconditions do not hold in authoritative state. The refusal has to come from application code, because no threshold on a peaked distribution will produce one — and note that the peak also suppresses probing, so the confident error is not caught by the information-gain machinery either.',
    rounds: [
      {
        distribution: {
          'RM-HSM-KEYSYNC': 0.91,
          'RM-FEED-RESUPPLY': 0.04,
          'RM-SCHEME-REARBITRATE': 0.02,
          'RM-MQ-RESTART-CHANNEL': 0.01,
          'RM-SPACE-EXTEND': 0.01,
          'RM-LOADLIB-REPOINT': 0.005,
          'none-of-these': 0.005,
        },
        evidenceSufficient: 0.88,
      },
    ],
  },
  {
    id: 'INC-4481',
    raisedAt: '2026-09-22T04:02:15Z',
    flow: 'NIGHTLY-GL',
    job: 'GLEXTR40',
    components: ['GLEXTR', 'DB2P01'],
    scheduler: { state: 'ENDED_NOT_OK', slaAt: '2026-09-22T06:30Z' },
    spool: [
      '04:02:09 JOB13120  +GLX0820I LEDGER SUMMARY PASS STARTED',
      '04:02:12 JOB13120  ZRX0917E LEDGER ADAPTER REJECTED BATCH - REASON QUALIFIER 0x5C',
      '04:02:15 JOB13120  IEF142I GLEXTR40 STEP020 - COND CODE 0008',
    ],
    fixtureNote:
      'Transport returns a structurally invalid answer. The SDK does not validate response shape, so the application must — and a call that cannot answer produces a refusal, not a guess.',
    fault: 'malformed',
  },
  {
    id: 'INC-4482',
    raisedAt: '2026-09-22T04:19:03Z',
    flow: 'NIGHTLY-CARDS',
    job: 'CDCLR40',
    components: ['CDCLR', 'MQ-CDCLR-CHL'],
    scheduler: { state: 'ENDED_NOT_OK', slaAt: '2026-09-22T05:00Z' },
    spool: [
      '04:19:00 JOB13188  +CDC0710I DISPUTE EXTRACT STARTED',
      '04:19:02 JOB13188  AMQ9509E PROGRAM CANNOT OPEN QUEUE CLR.DISPUTE.OUT, REASON 2085',
      '04:19:03 JOB13188  IEF142I CDCLR40 STEP010 - COND CODE 0008',
    ],
    fixtureNote:
      'The request times out. A decision point that cannot answer must not stall the batch window and must not invent an action.',
    fault: 'timeout',
  },
  {
    id: 'INC-4483',
    raisedAt: '2026-09-22T04:31:22Z',
    flow: 'NIGHTLY-CORE',
    job: 'CBSTMT30',
    components: ['CBSTMT'],
    scheduler: { state: 'ENDED_NOT_OK', slaAt: '2026-09-22T06:00Z' },
    spool: [
      '04:31:18 JOB13204  +CBS0810I STATEMENT RENDER PASS STARTED, 118,402 DOCUMENTS',
      '04:31:20 JOB13204  XDP4417E COMPOSITION ENGINE REJECTED RESOURCE SET - PROFILE 0x22 UNSUPPORTED',
      '04:31:21 JOB13204  XDP4418I RESOURCE SET LOADED FROM PROD.CBS.RENDER.PROF22',
      '04:31:22 JOB13204  IEF142I CBSTMT30 STEP040 - COND CODE 0008',
    ],
    operatorNote: 'Statement composition problem. Nothing in the batch catalog looks like this.',
    fixtureNote:
      'Document composition is outside the remediation catalog entirely. Scripted to answer none-of-these, which is categorical rather than uncertain: no diagnostic would move it, so no budget is spent before refusing.',
    rounds: [
      {
        distribution: {
          'none-of-these': 0.74,
          'RM-LOADLIB-REPOINT': 0.11,
          'RM-DATA-0C7': 0.07,
          'RM-DB2-RELIEVE-LOCK': 0.05,
          'RM-SPACE-EXTEND': 0.03,
        },
        evidenceSufficient: 0.69,
      },
    ],
  },
];
