/**
 * 12 — Compliance audit: rubric scoring of control evidence, then a draft assessment.
 *
 * Fields are extracted from each evidence document by a deterministic parser, so a
 * review date or a sample size is read, not guessed. Jev scores each control against a
 * rubric of meets, partially meets, or fails. A probe reads the change sample when the
 * score is flat. The gate checks that the evidence is no more than 90 days old. An
 * accepted finding is recorded as a reversible draft. The assessment is then drafted
 * from the findings with a template.
 *
 * Claims: each finding is recorded only when its evidence passes a deterministic date
 * check. A flat rubric score buys a read of the change sample, not a guess. The draft
 * assessment restates the findings and says what was and was not decided.
 *
 * Must not claim: that any control is effective or ineffective, that a sample is
 * representative, or that the draft is an audit opinion. The draft is never published:
 * sending it to an auditee is not automated. The narrative is templated, not written
 * by a generative model in this example, so its wording carries no model evidence.
 * Jev's scores are not calibrated, and the evidence is authored.
 *
 * Run: npm run fsi:compliance-audit
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

interface ControlRecord {
  controlId: string;
  evidence: string;
  fields: Record<string, string>;
  auditDate: string;
  unapprovedChanges: number;
  evidenceInFile: boolean;
  finding: string | null;
}

const AUDIT_DATE = '2026-10-08';
const MAX_EVIDENCE_AGE_DAYS = 90;

/** Reads "Label: value" lines. Anything else is left for the model to read. */
export function extractFields(evidence: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of evidence.split('\n')) {
    const match = /^([A-Za-z][A-Za-z ]*?):\s*(.+)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) fields[match[1].trim()] = match[2].trim();
  }
  return fields;
}

function ageInDays(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

const RATING: Record<string, string> = {
  meets: 'the control operated as described across the sample',
  partially_meets: 'the control operated for part of the sample',
  fails: 'the sample shows the control did not operate',
  [NONE]: 'the evidence supports none of these ratings',
};

const CHANGE_SAMPLE: ProbeSpec<ControlRecord> = {
  id: 'change-sample',
  cost: 1,
  description: 'read the change tickets in the sample for an approval',
  read: (r) => (r.unapprovedChanges > 0 ? 'unapproved-found' : 'all-approved'),
  buckets: {
    'unapproved-found': ['fails', 'partially_meets'],
    'all-approved': ['meets', 'partially_meets'],
  },
};

const EVIDENCE_FILE: ProbeSpec<ControlRecord> = {
  id: 'evidence-file',
  cost: 1,
  description: 'check whether the supporting file is in the evidence store',
  read: (r) => (r.evidenceInFile ? 'file-present' : 'file-absent'),
  buckets: {
    'file-absent': ['meets', 'partially_meets'],
    'file-present': ['fails', NONE],
  },
};

function control(id: string, evidence: string, overrides: Partial<ControlRecord> = {}): ControlRecord {
  return {
    controlId: id,
    evidence,
    fields: extractFields(evidence),
    auditDate: AUDIT_DATE,
    unapprovedChanges: 0,
    evidenceInFile: true,
    finding: null,
    ...overrides,
  };
}

function ratingDecision(
  record: ControlRecord,
  probes: ProbeSpec<ControlRecord>[],
  budget: number,
  scripted: Decision<ControlRecord>['scripted'],
  expect: Decision<ControlRecord>['expect'],
): Decision<ControlRecord> {
  return {
    id: record.controlId,
    title: `${record.controlId} — ${record.fields['Control'] ?? 'control'}`,
    instructions: 'How does the evidence rate this control? Choose none_of_these if the evidence supports none of the ratings.',
    options: RATING,
    indicators: { evidence_present: 'the evidence supports a conclusion about this control' },
    record,
    state: (r) => ({ control: r.fields['Control'], evidence: r.evidence }),
    probes,
    budget,
    scripted,
    gate: (r) => {
      const reviewed = r.fields['Reviewed on'];
      if (reviewed === undefined) return 'the evidence has no "Reviewed on" date to check';
      const age = ageInDays(reviewed, r.auditDate);
      return age > MAX_EVIDENCE_AGE_DAYS ? `the evidence is ${age} days old; the limit is ${MAX_EVIDENCE_AGE_DAYS}` : null;
    },
    plan: (option, record) => [
      setField<ControlRecord>({ id: 'finding', description: 'record the rating as a draft finding', field: 'finding', value: `${option}: ${record.fields['Control'] ?? record.controlId}` }),
    ],
    expect,
  };
}

const FLAT: Tally = { partially_meets: 0.4, fails: 0.3, meets: 0.25, [NONE]: 0.05 };

export function decisions(): Decision<ControlRecord>[] {
  return [
    ratingDecision(
      control(
        'AC-REVIEW',
        'Control: quarterly access review\nReviewed on: 2026-08-01\nReviewer: internal audit\nSample size: 25\nExceptions: 0',
      ),
      [],
      0,
      () => ({ distribution: { meets: 0.8, partially_meets: 0.12, fails: 0.05, [NONE]: 0.03 }, indicators: { evidence_present: 0.95 } }),
      { outcome: 'completed', flipped: false },
    ),
    // Flat on the rubric. The change sample is the read that settles it.
    ratingDecision(
      control(
        'CHG-APPROVAL',
        'Control: change approval\nReviewed on: 2026-09-15\nSample size: 40\nExceptions: 6',
        { unapprovedChanges: 6 },
      ),
      [CHANGE_SAMPLE],
      2,
      (obs) => {
        if (obs.includes('change-sample:unapproved-found')) {
          return { distribution: { fails: 0.84, partially_meets: 0.1, meets: 0.04, [NONE]: 0.02 }, indicators: { evidence_present: 0.9 } };
        }
        return { distribution: FLAT, indicators: { evidence_present: 0.7 } };
      },
      { outcome: 'completed', flipped: true },
    ),
    // Flat, and no budget is left for the probe that would read the evidence file.
    ratingDecision(
      control(
        'BACKUP-RESTORE',
        'Control: backup restore test\nReviewed on: 2026-07-10\nSample size: 4',
        { evidenceInFile: false },
      ),
      [EVIDENCE_FILE],
      0,
      () => ({ distribution: { partially_meets: 0.38, meets: 0.32, fails: 0.2, [NONE]: 0.1 }, indicators: { evidence_present: 0.4 } }),
      { outcome: 'refused' },
    ),
    // The evidence is too old for the gate, even though the model is confident.
    ratingDecision(
      control(
        'PRIV-ACCESS',
        'Control: privileged access\nReviewed on: 2026-03-02\nSample size: 12\nExceptions: 0',
      ),
      [],
      0,
      () => ({ distribution: { meets: 0.82, partially_meets: 0.1, fails: 0.05, [NONE]: 0.03 }, indicators: { evidence_present: 0.9 } }),
      { outcome: 'refused' },
    ),
  ];
}

/** A draft from the recorded findings. It is not published. */
export function draftAssessment(results: readonly Result[], records: readonly ControlRecord[]): string[] {
  const lines = [`Assessment draft, audit date ${AUDIT_DATE} (DRAFT: not published)`];
  for (const record of records) {
    const result = results.find((r) => r.id === record.controlId);
    const status = result?.outcome === 'completed' ? `finding: ${result.leader}` : `no finding recorded (${result?.reason ?? 'not decided'})`;
    lines.push(`- ${record.controlId}: ${status}`);
  }
  lines.push('Sending this draft to the auditee is not automated.');
  return lines;
}

export async function run(log: (line: string) => void = console.log): Promise<{ results: Result[]; draft: string[] }> {
  const results: Result[] = [];
  const records: ControlRecord[] = [];
  for (const decision of decisions()) {
    records.push(decision.record);
    results.push(await decide(decision, createClient(scriptFor(decision)), log));
  }
  return { results, draft: draftAssessment(results, records) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  fixtureBanner(isLiveJev());
  const { results, draft } = await run();
  printSummary(results);
  console.log('');
  for (const line of draft) console.log(line);
}
