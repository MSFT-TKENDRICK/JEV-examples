/**
 * Incident fixtures for example 08.
 *
 * Thirteen incidents from one overnight batch window. They are shaped to make one
 * thing visible: **most incidents in a batch shop are answered by lookups**, and
 * the ones that are not are not "harder tickets" — they are structurally
 * different. An unfamiliar vendor message, a cluster of low-level errors that
 * may all be consequences of one missing file, a condition the catalog does not
 * cover at all, and a case where the spool text and the dependency state point
 * at different subsystems.
 *
 * Everything here is manufactured, including the model's answers. The scripted
 * distributions are chosen to exercise application paths, not to represent how
 * Jev would actually respond. One fixture (`INC-4480`) is deliberately scripted
 * with a **confident and wrong** recommendation, because the fallback has to hold
 * when the model is wrong, and a demo where the model is always right proves
 * nothing about that.
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
  /** Scripted Jev answer, used only when the deterministic stage does not resolve. */
  scripted?: {
    runbook: string;
    /** Probability mass the mock places on `runbook`. */
    strength: number;
    evidenceSufficient: number;
  };
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
      'Mapped abend code. The table answers it, so no request is built and no model sees the spool.',
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
      'Dependency state answers it. Opening a second investigation here splits the bridge across one failure.',
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
      'Vendor message identifier absent from the mapping table. The candidate set is bounded by the affected CIs; discriminating among the remaining procedures is what is left.',
    scripted: { runbook: 'RB-CARD-SCHEME-CUTOVER', strength: 0.86, evidenceSufficient: 0.81 },
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
      'Several low-level errors that may share one upstream cause. Scripted as a split distribution: the policy sends split mass to the ordinary queue instead of picking a side.',
    scripted: { runbook: 'RB-FEED-LATE', strength: 0.37, evidenceSufficient: 0.44 },
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
      'Scripted CONFIDENTLY WRONG on purpose: high mass on a key-management procedure whose preconditions do not hold in authoritative state. The refusal has to come from application code, because no threshold on a peaked distribution will produce one.',
    scripted: { runbook: 'RB-HSM-KEYROT', strength: 0.91, evidenceSufficient: 0.88 },
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
      'Transport returns a structurally invalid answer. The SDK does not validate response shape, so the application must.',
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
      'The request times out. A decision point that cannot answer must not stall the batch bridge.',
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
      'Document composition is outside the runbook catalog entirely. Scripted to answer none-of-these, which is the escape hatch that keeps the model from being forced into a near-miss.',
    scripted: { runbook: 'none-of-these', strength: 0.74, evidenceSufficient: 0.69 },
  },
];
