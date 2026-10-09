/**
 * 14 — Search reranking: deterministic eligibility first, then a bounded choice.
 *
 * Retrieved documents are filtered by rules before any model call: jurisdiction and
 * product must match the query. Jev then chooses the document that answers the query
 * from the eligible set. A probe reads which version of the policy is current when
 * the choice is flat. The accepted document is ranked first by a reversible write.
 * The previous order is restored if the write does not verify.
 *
 * Claims: ineligible results never reach the model. A flat choice buys a read of the
 * current version, and a rank written to the result list is verified by reading it
 * back. A run that cannot decide leaves the ranking alone.
 *
 * Must not claim: that the ranked result is the correct answer to the customer's
 * question, that retrieval recall is adequate, or that the ranking improves any
 * measured search quality. Jev's choice is not calibrated, the documents are authored,
 * and the rules are illustrative. The ranking is for display, not for a decision.
 *
 * Run: npm run fsi:search-rerank
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

interface Doc {
  id: string;
  title: string;
  jurisdiction: string;
  product: string;
}

interface SearchRecord {
  queryId: string;
  question: string;
  jurisdiction: string;
  product: string;
  retrieved: Doc[];
  latestVersionOf: string;
  ranking: string[];
}

/** The rules run before any model call. Anything they remove is never offered to Jev. */
export function eligible(docs: readonly Doc[], jurisdiction: string, product: string): { kept: Doc[]; removed: Doc[] } {
  const kept = docs.filter((d) => d.jurisdiction === jurisdiction && d.product === product);
  return { kept, removed: docs.filter((d) => !kept.includes(d)) };
}

const DOCS: Doc[] = [
  { id: 'DOC-OD-2019', title: 'Overdraft refund policy (2019 edition)', jurisdiction: 'UK', product: 'current-account' },
  { id: 'DOC-OD-FEES', title: 'Current-account fee table', jurisdiction: 'UK', product: 'current-account' },
  { id: 'DOC-OD-2026', title: 'Overdraft refund policy (2026 edition)', jurisdiction: 'UK', product: 'current-account' },
  { id: 'DOC-OD-US', title: 'Overdraft refund policy (US edition)', jurisdiction: 'US', product: 'current-account' },
];

function choices(docs: readonly Doc[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const doc of docs) out[doc.id] = doc.title;
  out[NONE] = 'none of these answers the question';
  return out;
}

function versionProbe(ids: readonly string[]): ProbeSpec<SearchRecord> {
  return {
    id: 'version-check',
    cost: 1,
    description: 'read which edition of the policy is the current one',
    read: (r) => `version-${r.latestVersionOf}`,
    buckets: Object.fromEntries(ids.map((id) => [`version-${id}`, [id]])),
  };
}

function queryDecision(record: SearchRecord, budget: number, scripted: Decision<SearchRecord>['scripted'], expect: Decision<SearchRecord>['expect']): Decision<SearchRecord> {
  const { kept } = eligible(record.retrieved, record.jurisdiction, record.product);
  const ids = kept.map((d) => d.id);
  return {
    id: record.queryId,
    title: `${record.queryId} — ${record.question}`,
    instructions: 'Which eligible document answers this question? Choose none_of_these if none does.',
    options: choices(kept),
    record,
    state: (r) => ({ question: r.question, candidates: kept.map((d) => ({ id: d.id, title: d.title })) }),
    probes: ids.length > 0 ? [versionProbe(ids)] : [],
    budget,
    scripted,
    gate: () => null,
    plan: (option, r) => {
      const rest = r.ranking.filter((id) => id !== option);
      return [
        setField<SearchRecord>({ id: 'ranking', description: 'rank the chosen document first', field: 'ranking', value: [option, ...rest] }),
      ];
    },
    expect,
  };
}

export function decisions(): Decision<SearchRecord>[] {
  return [
    // Flat across the eligible editions. The version read settles it.
    queryDecision(
      {
        queryId: 'Q-101',
        question: 'What is the refund rule for an unarranged overdraft fee?',
        jurisdiction: 'UK',
        product: 'current-account',
        retrieved: DOCS,
        latestVersionOf: 'DOC-OD-2026',
        ranking: DOCS.map((d) => d.id),
      },
      1,
      (obs) => {
        if (obs.includes('version-check:version-DOC-OD-2026')) {
          return { distribution: { 'DOC-OD-2026': 0.82, 'DOC-OD-FEES': 0.08, 'DOC-OD-2019': 0.06, [NONE]: 0.04 } as Tally };
        }
        return { distribution: { 'DOC-OD-2019': 0.5, 'DOC-OD-2026': 0.3, 'DOC-OD-FEES': 0.15, [NONE]: 0.05 } as Tally };
      },
      { outcome: 'completed', flipped: true },
    ),
    // Confident from the start. No probe is bought.
    queryDecision(
      {
        queryId: 'Q-102',
        question: 'Which page lists the current-account fee table?',
        jurisdiction: 'UK',
        product: 'current-account',
        retrieved: DOCS,
        latestVersionOf: 'DOC-OD-2026',
        ranking: DOCS.map((d) => d.id),
      },
      1,
      () => ({ distribution: { 'DOC-OD-FEES': 0.9, 'DOC-OD-2019': 0.04, 'DOC-OD-2026': 0.04, [NONE]: 0.02 } as Tally }),
      { outcome: 'completed', flipped: false },
    ),
    // Flat, with a budget of one and no probe that settles it. The ranking is left alone.
    queryDecision(
      {
        queryId: 'Q-103',
        question: 'Can the bank refund an overdraft fee taken during a payment dispute?',
        jurisdiction: 'UK',
        product: 'current-account',
        retrieved: DOCS,
        latestVersionOf: 'DOC-OD-2026',
        ranking: DOCS.map((d) => d.id),
      },
      0,
      () => ({ distribution: { 'DOC-OD-2019': 0.36, 'DOC-OD-FEES': 0.33, 'DOC-OD-2026': 0.21, [NONE]: 0.1 } as Tally }),
      { outcome: 'refused' },
    ),
  ];
}

export async function run(log: (line: string) => void = console.log): Promise<Result[]> {
  const results: Result[] = [];
  for (const decision of decisions()) {
    const { removed } = eligible(decision.record.retrieved, decision.record.jurisdiction, decision.record.product);
    log(`  rules removed ${removed.length} result(s) before the model: ${removed.map((d) => d.id).join(', ') || 'none'}`);
    results.push(await decide(decision, createClient(scriptFor(decision)), log));
  }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  fixtureBanner(isLiveJev());
  printSummary(await run());
}
