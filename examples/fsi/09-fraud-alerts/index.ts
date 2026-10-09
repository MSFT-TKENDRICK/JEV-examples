/**
 * 09 — Fraud and AML alert prioritisation.
 *
 * Jev chooses a typology for an alert from a bounded list, probes read the
 * records, and the deterministic gate checks a claim against KYC before it is
 * accepted. Accepted alerts get a typology and a priority, which are reversible.
 *
 * Claims: alerts are ordered by priority and by how much evidence the run gathered.
 * A confident answer the records contradict is refused.
 *
 * Must not claim: that any alert is correct, closed, cleared or reported. Nothing
 * here disposes of an alert. Jev's distribution is not calibrated. The fixtures
 * are authored, and the typologies are illustrative rather than a regulatory
 * taxonomy. Routing an alert to an investigator is not implemented: the
 * architecture contract forbids routing uncertainty to a person.
 *
 * Run: npm run fsi:fraud-alerts
 */

import { pathToFileURL } from 'node:url';
import { createClient, isLiveJev } from '../../../src/client.ts';
import { fixtureBanner } from '../../../src/fixture-label.ts';
import {
  decide,
  NONE,
  printSummary,
  scriptFor,
  setField,
  type Decision,
  type ProbeSpec,
  type Result,
  type Tally,
} from '../../../src/decision-loop.ts';

interface AlertRecord {
  alertId: string;
  narrative: string;
  declaredCounterparty: boolean;
  payeeMatch: 'exact' | 'variant' | 'none';
  newDevice: boolean;
  priorAlerts: number;
  typology: string | null;
  priority: 'high' | 'standard' | null;
}

const HIGH_RISK = new Set(['structuring', 'mule_account', 'account_takeover']);

const TYPOLOGY: Record<string, string> = {
  structuring: 'transfers split to stay under a reporting threshold',
  mule_account: 'rapid pass-through of funds to recently added payees',
  account_takeover: 'changes from a new device followed by outbound payments',
  legitimate_pattern: 'a pattern the customer declared and the records support',
  [NONE]: 'none of the above fits the evidence',
};

const PAYEE_MATCH: ProbeSpec<AlertRecord> = {
  id: 'payee-match',
  cost: 1,
  description: 'match payee names against the counterparties in KYC',
  read: (r) => `payee-${r.payeeMatch}`,
  buckets: {
    'payee-exact': ['legitimate_pattern'],
    'payee-variant': ['mule_account', 'account_takeover'],
    'payee-none': ['structuring', 'mule_account'],
  },
};

const DEVICE_HISTORY: ProbeSpec<AlertRecord> = {
  id: 'device-history',
  cost: 2,
  description: 'check whether the session came from a device seen before on this account',
  read: (r) => (r.newDevice ? 'device-new' : 'device-known'),
  buckets: {
    'device-new': ['account_takeover', 'mule_account'],
    'device-known': ['structuring', 'legitimate_pattern'],
  },
};

const ALERT_HISTORY: ProbeSpec<AlertRecord> = {
  id: 'alert-history',
  cost: 3,
  description: 'count earlier alerts on the same customer',
  read: (r) => (r.priorAlerts > 0 ? 'history-prior' : 'history-none'),
  buckets: {
    'history-prior': ['structuring', 'mule_account'],
    'history-none': ['legitimate_pattern', 'account_takeover'],
  },
};

const FLAT: Tally = { structuring: 0.34, mule_account: 0.31, account_takeover: 0.2, legitimate_pattern: 0.1, [NONE]: 0.05 };
const LEGIT: Tally = { legitimate_pattern: 0.86, structuring: 0.06, mule_account: 0.03, account_takeover: 0.03, [NONE]: 0.02 };

function alert(overrides: Partial<AlertRecord> & Pick<AlertRecord, 'alertId' | 'narrative'>): AlertRecord {
  return {
    declaredCounterparty: false,
    payeeMatch: 'none',
    newDevice: false,
    priorAlerts: 0,
    typology: null,
    priority: null,
    ...overrides,
  };
}

function decisionFor(record: AlertRecord, probes: ProbeSpec<AlertRecord>[], budget: number, scripted: Decision<AlertRecord>['scripted'], expect: Decision<AlertRecord>['expect']): Decision<AlertRecord> {
  return {
    id: record.alertId,
    title: `${record.alertId} — ${record.narrative}`,
    instructions: 'Which typology best fits this alert? Choose none_of_these if none fits.',
    options: TYPOLOGY,
    record,
    state: (r) => ({ narrative: r.narrative, declaredCounterparty: r.declaredCounterparty }),
    probes,
    budget,
    scripted,
    gate: (r, option) =>
      option === 'legitimate_pattern' && !r.declaredCounterparty
        ? 'a legitimate_pattern label needs a counterparty the customer declared in KYC'
        : null,
    plan: (option) => [
      setField<AlertRecord>({ id: 'typology', description: 'attach the typology to the alert', field: 'typology', value: option }),
      setField<AlertRecord>({
        id: 'priority',
        description: 'set the priority band',
        field: 'priority',
        value: HIGH_RISK.has(option) ? 'high' : 'standard',
      }),
    ],
    expect,
  };
}

export function decisions(): Decision<AlertRecord>[] {
  return [
    // Flat at first. Payee names are the probe that changes the answer.
    decisionFor(
      alert({
        alertId: 'ALERT-2201',
        narrative: 'Five transfers of 9,800 GBP in four days to three payees added this week.',
        payeeMatch: 'none',
        newDevice: true,
      }),
      [PAYEE_MATCH, DEVICE_HISTORY, ALERT_HISTORY],
      4,
      (obs) => {
        if (obs.includes('payee-match:payee-none')) {
          return { distribution: { mule_account: 0.74, structuring: 0.16, account_takeover: 0.06, legitimate_pattern: 0.02, [NONE]: 0.02 } };
        }
        if (obs.includes('device-history:device-new')) {
          return { distribution: { account_takeover: 0.72, mule_account: 0.18, structuring: 0.06, legitimate_pattern: 0.03, [NONE]: 0.01 } };
        }
        return { distribution: FLAT };
      },
      { outcome: 'completed', flipped: true },
    ),
    // Flat throughout. The budget runs out and the alert is left as it was.
    decisionFor(
      alert({
        alertId: 'ALERT-2207',
        narrative: 'Two inbound and two outbound transfers with the same counterparty, no stated purpose.',
        payeeMatch: 'variant',
        priorAlerts: 2,
      }),
      [PAYEE_MATCH, DEVICE_HISTORY, ALERT_HISTORY],
      3,
      () => ({ distribution: FLAT }),
      { outcome: 'refused' },
    ),
    // Confident, and the KYC record agrees, so the gate passes.
    decisionFor(
      alert({
        alertId: 'ALERT-2212',
        narrative: 'Monthly payment to a utility the customer declared at onboarding.',
        declaredCounterparty: true,
        payeeMatch: 'exact',
      }),
      [PAYEE_MATCH, DEVICE_HISTORY],
      3,
      () => ({ distribution: LEGIT }),
      { outcome: 'completed', flipped: false },
    ),
    // Confident, and the KYC record does not agree. The gate refuses.
    decisionFor(
      alert({
        alertId: 'ALERT-2219',
        narrative: 'Monthly payment to a supplier that is not in the declared profile.',
        declaredCounterparty: false,
        payeeMatch: 'none',
      }),
      [PAYEE_MATCH],
      3,
      () => ({ distribution: LEGIT }),
      { outcome: 'refused', flipped: false },
    ),
  ];
}

export interface Run {
  results: Result[];
  /** Completed alerts first, high priority first, then by the evidence gathered. */
  queue: { id: string; typology: string | null; priority: string | null; probes: number; outcome: string }[];
}

export async function run(log: (line: string) => void = console.log): Promise<Run> {
  const results: Result[] = [];
  const queue: Run['queue'] = [];
  for (const decision of decisions()) {
    const result = await decide(decision, createClient(scriptFor(decision)), log);
    results.push(result);
    queue.push({
      id: decision.id,
      typology: decision.record.typology,
      priority: decision.record.priority,
      probes: result.probes.length,
      outcome: result.outcome,
    });
  }
  queue.sort((a, b) => {
    const rank = (row: Run['queue'][number]) => (row.outcome !== 'completed' ? 2 : row.priority === 'high' ? 0 : 1);
    return rank(a) - rank(b) || b.probes - a.probes;
  });
  return { results, queue };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  fixtureBanner(isLiveJev());
  const { results, queue } = await run();
  printSummary(results);
  console.log('\nPriority order (alerts not completed keep their existing position)');
  for (const row of queue) {
    console.log(`  ${row.id.padEnd(12)} ${(row.priority ?? 'unchanged').padEnd(10)} ${(row.typology ?? '—').padEnd(20)} ${row.probes} probe(s)  ${row.outcome}`);
  }
}
