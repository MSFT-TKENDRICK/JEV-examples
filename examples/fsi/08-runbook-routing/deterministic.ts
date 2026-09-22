/**
 * The deterministic stage — everything that must never reach a model.
 *
 * The rule this implements is one sentence: **if an authoritative source knows
 * the answer, the authoritative source answers.** The scheduler knows which job
 * failed first. The incident system knows what is already open. The abend table
 * is a human-maintained mapping. The reconciliation control knows whether the
 * totals balance.
 *
 * Running these first is not an optimization. It is what keeps the residual
 * genuinely semantic: if the lookups did not run, a model would be asked
 * questions that have exact answers, and its errors on those questions would be
 * indistinguishable from its errors on the hard ones.
 *
 * Every branch below returns the source it consulted and that source's version,
 * so a ledger record can be re-derived later against the same snapshot.
 */

import { ABEND_RUNBOOKS, ABEND_TABLE_VERSION, SCHEDULER_RESTARTABLE } from '../../../src/runbook-catalog.ts';
import type { Incident } from './fixtures.ts';
import type { Route } from './policy.ts';

export interface Resolved {
  resolved: true;
  route: Route;
  /** The authoritative system that produced the answer. */
  source: string;
  sourceVersion: string;
  /** What the harness does, stated as an action rather than a conclusion. */
  action: string;
  runbookId?: string;
  reason: string;
}

export interface Residual {
  resolved: false;
  /** Why the lookups did not settle it. Drives what appears in the output. */
  residual:
    | 'unmapped_vendor_message'
    | 'multiple_symptoms_no_mapping'
    | 'conflicting_signals'
    | 'unmapped_condition';
  reason: string;
}

export type DeterministicOutcome = Resolved | Residual;

/** Message identifiers that look like vendor codes but are not in any table. */
const VENDOR_MESSAGE = /\b[A-Z]{2,4}\d{3,4}[EWS]\b/;

/** Distinct subsystem symptom families, used to describe *shape*, not cause. */
const SYMPTOM_FAMILIES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'db2', pattern: /SQLCODE\s*=?\s*-\d+|DSNT4\d\dI/ },
  { name: 'mq', pattern: /\bAMQ\d{4}/ },
  { name: 'dataset', pattern: /TRAILER COUNT 0|EMPTY|NOT FOUND/ },
  { name: 'security', pattern: /PIN VERIFY|KCV|KEY SET/ },
];

/**
 * Resolves what can be resolved.
 *
 * Rule order is deliberate, because several rules can match one incident and the
 * cheapest correct suppression should win: an alert repeat during an open
 * incident should not become a dependency investigation, and a dependency wait
 * should not become an abend lookup on a job that never ran.
 */
export function resolveDeterministically(incident: Incident): DeterministicOutcome {
  const { scheduler } = incident;

  // 1. Alert repeats. Ordinary in a storm, and a pure lookup on open incidents.
  const duplicate = incident.possibleDuplicateOf;
  if (duplicate && duplicate.job === incident.job && duplicate.abendCode === incident.abendCode) {
    return {
      resolved: true,
      route: 'suppressed_duplicate',
      source: 'incident-system',
      sourceVersion: 'open-incidents',
      action: `append to ${duplicate.incidentId}`,
      reason: `repeat alert for ${incident.job} while ${duplicate.incidentId} is open`,
    };
  }

  // 2. Dependency state. The scheduler knows which job actually failed.
  if (scheduler.state === 'WAITING_PREDECESSOR' && scheduler.predecessor) {
    const { job, state, incidentId } = scheduler.predecessor;
    return {
      resolved: true,
      route: 'linked_to_predecessor',
      source: 'scheduler-dependency-graph',
      sourceVersion: 'live',
      action: incidentId ? `link to ${incidentId}` : `link to predecessor ${job}`,
      reason: `held behind ${job} (${state}); the predecessor carries the investigation`,
    };
  }

  // 3. Scheduler-owned restarts. Its retry budget is policy, not judgment.
  if (scheduler.state === 'RESTART_PENDING' && scheduler.restartCode) {
    const budget = SCHEDULER_RESTARTABLE[scheduler.restartCode];
    const attempt = scheduler.attempt ?? 0;
    if (budget !== undefined && attempt < budget) {
      return {
        resolved: true,
        route: 'scheduler_retry',
        source: 'scheduler-restart-policy',
        sourceVersion: 'live',
        action: 'no action; scheduler retrying',
        reason: `${scheduler.restartCode} is restartable, attempt ${attempt} of ${budget}`,
      };
    }
  }

  // 4. Control totals. A break is a control matter with a prescribed response.
  const reconciliation = incident.reconciliation;
  if (reconciliation && reconciliation.expectedItems !== reconciliation.actualItems) {
    const variance = reconciliation.expectedItems - reconciliation.actualItems;
    return {
      resolved: true,
      route: 'freeze_downstream',
      source: 'reconciliation-control',
      sourceVersion: reconciliation.control,
      action: 'freeze downstream submission and page the control owner',
      runbookId: 'RB-CTL-BREAK',
      reason: `control ${reconciliation.control} out by ${variance} items; prescribed response, no model involved`,
    };
  }

  // 5. The abend mapping table.
  if (incident.abendCode) {
    const runbookId = ABEND_RUNBOOKS[incident.abendCode];
    if (runbookId) {
      return {
        resolved: true,
        route: 'deterministic_runbook',
        source: 'abend-mapping-table',
        sourceVersion: ABEND_TABLE_VERSION,
        action: `open ${runbookId}`,
        runbookId,
        reason: `${incident.abendCode} is mapped`,
      };
    }
  }

  return residualFor(incident);
}

/**
 * Describes the *shape* of what is left over.
 *
 * This classification drives output and nothing else. It says how many symptom
 * families appear in the spool and whether an unmapped vendor identifier is
 * present — both surface features of the text. It does not assert a cause, and
 * an incident labelled `multiple_symptoms_no_mapping` is not thereby a single
 * underlying condition.
 */
function residualFor(incident: Incident): Residual {
  const text = incident.spool.join('\n');
  const families = SYMPTOM_FAMILIES.filter((family) => family.pattern.test(text)).map((f) => f.name);
  const hasVendorMessage = VENDOR_MESSAGE.test(text);

  if (families.includes('security') && families.length > 1) {
    return {
      resolved: false,
      residual: 'conflicting_signals',
      reason: `spool text spans ${families.join(' + ')}; dependency state and message text disagree`,
    };
  }
  if (families.length > 1) {
    return {
      resolved: false,
      residual: 'multiple_symptoms_no_mapping',
      reason: `${families.length} symptom families in one window (${families.join(', ')}), none mapped`,
    };
  }
  if (hasVendorMessage) {
    return {
      resolved: false,
      residual: 'unmapped_vendor_message',
      reason: 'vendor message identifier is not present in the mapping table',
    };
  }
  return {
    resolved: false,
    residual: 'unmapped_condition',
    reason: 'no mapped abend, no dependency answer, no control break',
  };
}
