/**
 * 09 — Fraud triage: alerts, transactions and customer reports.
 *
 * One bounded decision, three uses.
 *
 *   Alerts        Jev chooses a typology from a fixed list. Probes read KYC, the device
 *                 history and the alert history when the answer is flat. A gate refuses
 *                 a "legitimate pattern" label that KYC does not support. Accepted alerts
 *                 get a typology and a priority, both reversible.
 *   Transactions  The same transaction is judged twice, with one field changed (device
 *                 trust). The distribution moves with the field, and the run says so.
 *   Customer      A customer's report is classified by intent. In the same request, yes/no
 *   reports       signals say whether it is high risk and which servicing tools the next
 *                 step needs. The tools that pass are written as a shortlist. No tool is run.
 *
 * Claims: alerts are ordered by priority and by how much evidence the run gathered. A
 * changed field moves the distribution, and a probe on a record can change the answer. A
 * confident answer the records contradict is refused. Two alerts with the same leader can
 * differ in confidence, and only the confident one is acted on.
 *
 * Must not claim: that any transaction is fraudulent, safe, approved or held. Authorisation
 * is out of scope: approving, holding or challenging a transaction is a decision about what a
 * principal may do, which FSI-BOUNDARIES.md prohibits. Nothing here closes or clears an
 * alert, escalates, or routes to a reviewer. The shortlist is data; no tool is executed and
 * no reasoning model is called. Jev's distribution is not calibrated, and the fixtures are
 * authored.
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
  toolShortlist: string[] | null;
}

const HIGH_RISK = new Set(['structuring', 'mule_account', 'account_takeover', 'fraud_report']);

const TYPOLOGY: Record<string, string> = {
  structuring: 'transfers split to stay under a reporting threshold',
  mule_account: 'rapid pass-through of funds to recently added payees',
  account_takeover: 'changes from a new device followed by outbound payments',
  legitimate_pattern: 'a pattern the customer declared and the records support',
  [NONE]: 'none of the above fits the evidence',
};

const REPORT_INTENT: Record<string, string> = {
  fraud_report: 'the customer says a transaction was not theirs',
  dispute: 'the customer wants a charge reversed',
  inquiry: 'a question with no fraud content',
  [NONE]: 'none of the above fits the report',
};

/** Each signal is a separate yes/no question. Tools are not mutually exclusive, so they are not one choice. */
const REPORT_SIGNALS: Record<string, string> = {
  high_risk: 'the report shows several fraud signals at once',
  get_transactions: 'the next step needs the transaction history',
  lock_account: 'the next step needs the card or account locked',
  initiate_fraud_case: 'the next step needs a fraud case opened',
  get_customer_profile: 'the next step needs the customer profile',
  mortgage_payoff: 'the request is about a mortgage',
  wealth_portfolio: 'the request is about investments',
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
const NEW_DEVICE: Tally = { account_takeover: 0.72, mule_account: 0.18, structuring: 0.06, legitimate_pattern: 0.03, [NONE]: 0.01 };
const KNOWN_DEVICE: Tally = { structuring: 0.6, legitimate_pattern: 0.2, mule_account: 0.1, account_takeover: 0.05, [NONE]: 0.05 };

function alert(overrides: Partial<AlertRecord> & Pick<AlertRecord, 'alertId' | 'narrative'>): AlertRecord {
  return {
    declaredCounterparty: false,
    payeeMatch: 'none',
    newDevice: false,
    priorAlerts: 0,
    typology: null,
    priority: null,
    toolShortlist: null,
    ...overrides,
  };
}

function typologyDecision(
  record: AlertRecord,
  probes: ProbeSpec<AlertRecord>[],
  budget: number,
  scripted: Decision<AlertRecord>['scripted'],
  expect: Decision<AlertRecord>['expect'],
): Decision<AlertRecord> {
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

/** A customer report: intent as the choice, with per-tool signals asked in the same request. */
function customerReport(record: AlertRecord, expect: Decision<AlertRecord>['expect']): Decision<AlertRecord> {
  return {
    id: record.alertId,
    title: `${record.alertId} — ${record.narrative}`,
    instructions: 'What is the customer asking for? Choose none_of_these if none fits.',
    options: REPORT_INTENT,
    indicators: REPORT_SIGNALS,
    record,
    state: (r) => ({ report: r.narrative }),
    probes: [],
    budget: 0,
    scripted: () => ({
      distribution: { fraud_report: 0.9, dispute: 0.05, inquiry: 0.03, [NONE]: 0.02 },
      indicators: {
        high_risk: 0.91,
        get_transactions: 0.98,
        lock_account: 0.93,
        initiate_fraud_case: 0.88,
        get_customer_profile: 0.41,
        mortgage_payoff: 0.01,
        wealth_portfolio: 0,
      },
    }),
    gate: () => null,
    plan: (option, _r, indicators) => [
      setField<AlertRecord>({ id: 'typology', description: 'record what the customer is asking for', field: 'typology', value: option }),
      setField<AlertRecord>({
        id: 'priority',
        description: 'set the priority band from the high-risk signal',
        field: 'priority',
        value: (indicators['high_risk'] ?? 0) >= 0.5 ? 'high' : 'standard',
      }),
      setField<AlertRecord>({
        id: 'tool-shortlist',
        description: 'write the tools the next step needs; none is run',
        field: 'toolShortlist',
        value: Object.keys(REPORT_SIGNALS).filter((tool) => tool !== 'high_risk' && (indicators[tool] ?? 0) >= 0.5),
      }),
    ],
    expect,
  };
}

export function decisions(): Decision<AlertRecord>[] {
  const device = (newDevice: boolean) => ({ newDevice });
  return [
    // Flat at first. Payee names are the probe that changes the answer.
    typologyDecision(
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
        if (obs.includes('device-history:device-new')) return { distribution: NEW_DEVICE };
        return { distribution: FLAT };
      },
      { outcome: 'completed', flipped: true },
    ),
    // Flat throughout. The budget runs out and the alert is left as it was.
    typologyDecision(
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
    typologyDecision(
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
    typologyDecision(
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
    // Same leader as the next alert, but only 46% of the mass. Not acted on.
    typologyDecision(
      alert({ alertId: 'ALERT-2231', narrative: 'Transfers to a payee that matches a recent alert, moderate values.' }),
      [],
      0,
      () => ({ distribution: { mule_account: 0.46, structuring: 0.43, account_takeover: 0.06, legitimate_pattern: 0.03, [NONE]: 0.02 } }),
      { outcome: 'refused' },
    ),
    // Same leader, 96% of the mass. Acted on.
    typologyDecision(
      alert({ alertId: 'ALERT-2232', narrative: 'Transfers to a payee that matches a recent alert, the same pattern repeated.' }),
      [],
      0,
      () => ({ distribution: { mule_account: 0.96, structuring: 0.02, account_takeover: 0.01, legitimate_pattern: 0.01, [NONE]: 0 } }),
      { outcome: 'completed', flipped: false },
    ),
    // What-if: the transaction with its device unknown. The device probe moves it to account takeover.
    typologyDecision(
      alert({
        alertId: 'TXN-884',
        narrative: 'BESTBUY #124, $2,849, card-present. Card from Chicago, merchant in Miami. 11-year account, no similar transactions. Device trust unknown.',
        ...device(true),
      }),
      [DEVICE_HISTORY],
      3,
      (obs) => (obs.includes('device-history:device-new') ? { distribution: NEW_DEVICE } : { distribution: FLAT }),
      { outcome: 'completed', flipped: true },
    ),
    // What-if: the same transaction with a known device. The distribution moves, and it is not confident enough to act.
    typologyDecision(
      alert({
        alertId: 'TXN-884b',
        narrative: 'Same transaction, device trust known: the card holder\'s usual phone.',
        ...device(false),
      }),
      [DEVICE_HISTORY],
      3,
      (obs) => (obs.includes('device-history:device-known') ? { distribution: KNOWN_DEVICE } : { distribution: FLAT }),
      { outcome: 'refused', flipped: false },
    ),
    // One request, three questions: intent, a high-risk signal, and the tools the next step needs.
    customerReport(
      alert({
        alertId: 'REPORT-7720',
        narrative: 'I just got an alert for an $1,850 purchase at Apple and that was not me.',
      }),
      { outcome: 'completed', flipped: false },
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
    if (result.outcome === 'completed' && decision.record.toolShortlist !== null) {
      log(`  shortlist written: ${decision.record.toolShortlist.join(', ') || 'none'} (not run)`);
    }
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
  console.log('\nPriority order (items not completed keep their existing position)');
  for (const row of queue) {
    console.log(`  ${row.id.padEnd(12)} ${(row.priority ?? 'unchanged').padEnd(10)} ${(row.typology ?? '—').padEnd(20)} ${row.probes} probe(s)  ${row.outcome}`);
  }
}
