/**
 * 10 — Insurance claims: first-notice classification and risk indicators.
 *
 * Jev classifies a first-notice-of-loss report by claim type, and asks two yes/no
 * questions in the same request: whether documents are missing, and whether the
 * report has fraud indicators. A probe reads the claim history or the document
 * checklist when the answer is flat. The gate refuses a claim with a fraud
 * indicator at or above 0.5, or with no policy in force. Accepted claims get a
 * type, a lane and stored risk indicators, all reversible.
 *
 * Claims: the run classifies the claim and records indicators that can feed a
 * later underwriting or risk model. A confident answer is refused when the
 * deterministic checks disagree with it. A failed write rolls back the earlier
 * writes.
 *
 * Must not claim: that any claim is paid, approved, denied or fraudulent. Nothing
 * here moves money. A "standard" lane does not mean straight-through payment.
 * Adjuster review, SIU review and total-loss review are not offered as options: each
 * routes to a person, which the architecture contract forbids. Jev's indicators are not
 * calibrated, and the fixtures are authored.
 *
 * Run: npm run fsi:insurance-claims
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

interface ClaimRecord {
  claimId: string;
  report: string;
  policyInForce: boolean;
  priorClaims12m: number;
  documentsReceived: string[];
  documentsRequired: string[];
  annotationStoreUp: boolean;
  claimType: string | null;
  lane: string | null;
  annotations: string | null;
}

const CLAIM_TYPE: Record<string, string> = {
  property_water: 'water or fire damage to a home',
  motor_collision: 'vehicle collision, own or third-party damage',
  injury: 'bodily injury with medical treatment reported',
  subrogation: 'a loss a third party probably caused and should repay',
  [NONE]: 'none of the above fits the report',
};

const INDICATORS: Record<string, string> = {
  missing_documents: 'the report lacks documents this kind of claim normally needs',
  fraud_indicators: 'the report has characteristics that warrant a fraud check',
};

const CLAIMS_HISTORY: ProbeSpec<ClaimRecord> = {
  id: 'claims-history',
  cost: 1,
  description: 'count claims by this policyholder in the last 12 months',
  read: (r) => (r.priorClaims12m >= 2 ? 'history-repeat' : 'history-single'),
  buckets: {
    'history-repeat': ['injury', 'motor_collision'],
    'history-single': ['property_water', 'subrogation'],
  },
};

const DOCUMENT_CHECK: ProbeSpec<ClaimRecord> = {
  id: 'document-check',
  cost: 2,
  description: 'compare the documents received with the checklist for this claim type',
  read: (r) => (r.documentsRequired.every((d) => r.documentsReceived.includes(d)) ? 'documents-complete' : 'documents-missing'),
  buckets: {
    'documents-missing': ['motor_collision', 'injury'],
    'documents-complete': ['property_water', 'subrogation'],
  },
};

const FLAT: Tally = { motor_collision: 0.4, injury: 0.36, property_water: 0.12, subrogation: 0.07, [NONE]: 0.05 };
const WATER: Tally = { property_water: 0.86, motor_collision: 0.06, injury: 0.03, subrogation: 0.03, [NONE]: 0.02 };

function claim(overrides: Partial<ClaimRecord> & Pick<ClaimRecord, 'claimId' | 'report'>): ClaimRecord {
  return {
    policyInForce: true,
    priorClaims12m: 0,
    documentsReceived: [],
    documentsRequired: [],
    annotationStoreUp: true,
    claimType: null,
    lane: null,
    annotations: null,
    ...overrides,
  };
}

const rounded = (indicators: Tally): Record<string, number> =>
  Object.fromEntries(Object.entries(indicators).map(([id, p]) => [id, Math.round(p * 100) / 100]));

function decisionFor(
  record: ClaimRecord,
  probes: ProbeSpec<ClaimRecord>[],
  budget: number,
  scripted: Decision<ClaimRecord>['scripted'],
  expect: Decision<ClaimRecord>['expect'],
): Decision<ClaimRecord> {
  return {
    id: record.claimId,
    title: `${record.claimId} — ${record.report}`,
    instructions: 'Which type of claim does this first-notice report describe? Choose none_of_these if none fits.',
    options: CLAIM_TYPE,
    indicators: INDICATORS,
    record,
    state: (r) => ({ report: r.report }),
    probes,
    budget,
    scripted,
    gate: (r, option, indicators) => {
      if (!r.policyInForce) return 'no policy in force for this claim';
      const fraud = indicators['fraud_indicators'] ?? 0;
      if (fraud >= 0.5) return `fraud indicators at ${Math.round(fraud * 100)}%, so the claim is not set automatically`;
      return null;
    },
    plan: (option, _record, indicators) => [
      setField<ClaimRecord>({ id: 'claim-type', description: 'record the claim type', field: 'claimType', value: option }),
      setField<ClaimRecord>({
        id: 'lane',
        description: 'set the processing lane; a standard lane does not pay the claim',
        field: 'lane',
        value: (indicators['missing_documents'] ?? 0) >= 0.5 ? 'pending-documents' : 'standard',
      }),
      setField<ClaimRecord>({
        id: 'annotations',
        description: 'store the risk indicators with the claim',
        field: 'annotations',
        value: JSON.stringify(rounded(indicators)),
        healthy: (r) => r.annotationStoreUp,
        unhealthyReason: 'the annotation store is unavailable',
      }),
    ],
    expect,
  };
}

export function decisions(): Decision<ClaimRecord>[] {
  return [
    // Confident and complete. Accepted, with the indicators stored.
    decisionFor(
      claim({
        claimId: 'FNOL-5530',
        report: 'Kitchen flooded overnight after a dishwasher hose split; plumber invoice attached.',
        documentsReceived: ['invoice'],
        documentsRequired: ['invoice'],
      }),
      [CLAIMS_HISTORY, DOCUMENT_CHECK],
      3,
      () => ({
        distribution: WATER,
        indicators: { missing_documents: 0.1, fraud_indicators: 0.08 },
      }),
      { outcome: 'completed', flipped: false },
    ),
    // Torn between motor and injury. The claims history changes the answer, and
    // the fraud indicator it raises stops the claim being set automatically.
    decisionFor(
      claim({
        claimId: 'FNOL-5544',
        report: 'Rear-ended at a junction; driver reports neck pain, no police attendance.',
        priorClaims12m: 3,
        documentsRequired: ['photos', 'medical-record'],
      }),
      [CLAIMS_HISTORY, DOCUMENT_CHECK],
      3,
      (obs) => {
        const repeat = obs.includes('claims-history:history-repeat');
        const missing = obs.includes('document-check:documents-missing');
        if (repeat) {
          return {
            distribution: { injury: 0.78, motor_collision: 0.1, property_water: 0.06, subrogation: 0.04, [NONE]: 0.02 },
            indicators: { missing_documents: missing ? 0.55 : 0.3, fraud_indicators: 0.71 },
          };
        }
        if (missing) {
          return {
            distribution: { motor_collision: 0.52, injury: 0.3, property_water: 0.1, subrogation: 0.05, [NONE]: 0.03 },
            indicators: { missing_documents: 0.55, fraud_indicators: 0.2 },
          };
        }
        return {
          distribution: FLAT,
          indicators: { missing_documents: 0.3, fraud_indicators: 0.2 },
        };
      },
      { outcome: 'refused' },
    ),
    // Flat throughout, with a budget too small for the probe that would split it.
    decisionFor(
      claim({
        claimId: 'FNOL-5551',
        report: 'Damage to a parked car from a falling branch; the owner did not report a driver.',
        priorClaims12m: 1,
        documentsReceived: ['photos'],
        documentsRequired: ['photos'],
      }),
      [CLAIMS_HISTORY, DOCUMENT_CHECK],
      2,
      () => ({ distribution: FLAT, indicators: { missing_documents: 0.2, fraud_indicators: 0.1 } }),
      { outcome: 'refused' },
    ),
    // Confident and complete: the brief's auto claim. The standard lane is a label; nothing is paid.
    decisionFor(
      claim({
        claimId: 'FNOL-5571',
        report: 'Rear-ended while stopped; police report attached, car drivable, no injuries reported.',
        priorClaims12m: 2,
        documentsReceived: ['police-report'],
        documentsRequired: ['police-report'],
      }),
      [CLAIMS_HISTORY],
      2,
      () => ({
        distribution: { motor_collision: 0.84, injury: 0.06, property_water: 0.04, subrogation: 0.04, [NONE]: 0.02 },
        indicators: { missing_documents: 0.1, fraud_indicators: 0.18 },
      }),
      { outcome: 'completed', flipped: false },
    ),
    // The same claim with the damage photos missing. The lane waits on the claimant.
    decisionFor(
      claim({
        claimId: 'FNOL-5572',
        report: 'Rear-ended while stopped; police report attached, damage photos not yet sent.',
        documentsReceived: ['police-report'],
        documentsRequired: ['police-report', 'photos'],
      }),
      [DOCUMENT_CHECK],
      2,
      () => ({
        distribution: { motor_collision: 0.84, injury: 0.06, property_water: 0.04, subrogation: 0.04, [NONE]: 0.02 },
        indicators: { missing_documents: 0.72, fraud_indicators: 0.18 },
      }),
      { outcome: 'completed', flipped: false },
    ),
    // Confident and complete, but the annotation store is down. The first two writes are undone.
    decisionFor(
      claim({
        claimId: 'FNOL-5560',
        report: 'Kitchen flooded overnight after a dishwasher hose split; plumber invoice attached.',
        documentsReceived: ['invoice'],
        documentsRequired: ['invoice'],
        annotationStoreUp: false,
      }),
      [CLAIMS_HISTORY],
      3,
      () => ({
        distribution: WATER,
        indicators: { missing_documents: 0.1, fraud_indicators: 0.08 },
      }),
      { outcome: 'rolled_back' },
    ),
  ];
}

export async function run(log: (line: string) => void = console.log): Promise<Result[]> {
  const results: Result[] = [];
  for (const decision of decisions()) {
    results.push(await decide(decision, createClient(scriptFor(decision)), log));
  }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  fixtureBanner(isLiveJev());
  printSummary(await run());
}
