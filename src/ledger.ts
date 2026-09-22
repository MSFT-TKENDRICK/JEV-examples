/**
 * The decision ledger.
 *
 * ## What this is
 *
 * One record per Jev-influenced decision, capturing the inputs the application
 * could see, the distribution it received, the policy it applied, **what Jev
 * recommended, and separately what the harness actually did**. That last split is
 * the point. A log that only stores the model's answer cannot later distinguish a
 * model error from a policy bug, an operator override, or an execution failure.
 *
 * ## What this is not
 *
 * This is *evidence capture that may support governance*. It is not an audit
 * trail merely because it emits records. Specifically, this module does **not**
 * provide and must not be described as providing:
 *
 * - tamper evidence, immutability, or independent verification
 * - completeness guarantees
 * - access control, encryption, retention, or deletion handling
 * - anonymity — a hash of state is not automatically non-sensitive
 * - reproducibility, unless fixtures, code, candidate catalogs, policies and
 *   service versions are *all* retained alongside it
 * - satisfaction of SR 11-7, OCC, FFIEC, PCI DSS, SOX or any internal
 *   model-risk requirement
 *
 * Raw distributions record *what* the service returned. They do not explain
 * *why*, and storing them establishes nothing about validity or calibration.
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunMode } from './fixture-label.ts';

/** Where a bounded option set came from, so a record can be re-derived later. */
export interface CandidateProvenance {
  /** The authoritative system the options came from, e.g. 'card-system-of-record'. */
  source: string;
  /** Version or snapshot identifier of that source. */
  version: string;
  /** Stable IDs of every option offered, in the order offered. */
  optionIds: readonly string[];
  /** When the options were read from the source. */
  readAt: string;
}

/** A redacted reference to the state sent, never the state itself. */
export interface StateReference {
  /** SHA-256 over the canonical serialization of the state that was sent. */
  hash: string;
  /** Top-level field names included in the request. Names only, never values. */
  fieldsSent: readonly string[];
  /** Field names deliberately withheld from the request, for minimization review. */
  fieldsWithheld?: readonly string[];
}

/** What Jev returned. Absent when the call failed. */
export interface Recommendation {
  question: string;
  choice?: string;
  probabilities?: Readonly<Record<string, number>>;
  /** The SDK's reported confidence, which is a different statistic from the
   * selected option's probability. Both are recorded because they differ. */
  confidence?: number;
}

/** Distribution statistics the application computed and acted on. */
export interface DistributionMetrics {
  /** Probability assigned to the option actually selected. */
  selectedProbability: number;
  /** Top-1 minus top-2. A peaked-but-contested distribution has a small margin. */
  margin: number;
  /** Normalized entropy, 0 (certain) to 1 (uniform). */
  normalizedEntropy: number;
  /** Number of options offered. Thresholds are not portable across this value. */
  optionCount: number;
}

/** The policy decision the application made, and why. */
export interface PolicyOutcome {
  /** Version of the policy/threshold set applied. */
  policyVersion: string;
  /** Thresholds in force for this decision. */
  thresholds: Readonly<Record<string, number>>;
  /** The route taken, e.g. 'auto', 'approval_required', 'escalated', 'refused'. */
  route: string;
  /** Human-readable reason the route was chosen. */
  reason: string;
}

/** How a call failed, when it did. */
export interface FailureOutcome {
  kind: 'timeout' | 'malformed_response' | 'service_error' | 'stale_state' | 'other';
  detail: string;
  /** What the application did instead. Fail closed where consequential. */
  fallback: string;
}

/** A human's final disposition, recorded separately from Jev's answer. */
export interface Override {
  /** The authorization principal, e.g. 'customer', 'agent', 'ops_reviewer'. */
  principal: string;
  finalDisposition: string;
  at: string;
  note?: string;
}

export interface DecisionRecord {
  decisionId: string;
  /** Correlates several decisions belonging to one workflow run. */
  runId: string;
  timestamp: string;
  /** Scripted fixture or real service. Never inferred at read time. */
  mode: RunMode;
  /** The example or component that made the decision. */
  component: string;
  service: {
    model: string;
    sdkPackage: string;
    sdkVersion: string;
  };
  /** Build identifier, so a record can be tied to the code that produced it. */
  codeVersion: string;
  state: StateReference;
  candidates: CandidateProvenance;
  recommendation: Recommendation | null;
  metrics: DistributionMetrics | null;
  policy: PolicyOutcome;
  /**
   * What the harness actually did. Deliberately separate from `recommendation`,
   * because they are allowed to differ and the difference is the interesting part.
   */
  executed: {
    action: string;
    /** True when the executed action differs from Jev's top choice. */
    divergedFromRecommendation: boolean;
    arguments?: Readonly<Record<string, string>>;
  };
  override: Override | null;
  failure: FailureOutcome | null;
  latencyMs: number;
}

/** Canonical JSON so equal states hash equally regardless of key order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * Hashes the state that was sent.
 *
 * A hash is a *reference*, not anonymization. A low-cardinality field — an
 * account number, a card ID — is trivially recoverable by brute force, so treat
 * these records as carrying the same classification as the underlying data.
 */
export function hashState(state: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(state)).digest('hex')}`;
}

/** Derives the statistics a policy should be reasoning about. */
export function metricsFor(
  probabilities: Readonly<Record<string, number>>,
  selected: string,
): DistributionMetrics {
  const values = Object.values(probabilities);
  const sorted = [...values].sort((a, b) => b - a);
  const optionCount = values.length;
  const entropy = -values.reduce((sum, p) => (p > 0 ? sum + p * Math.log(p) : sum), 0);
  // Derived values are rounded so ledger records stay readable and diffable;
  // raw float subtraction otherwise writes artefacts like 0.21000000000000002.
  const round = (value: number) => Math.round(value * 1e6) / 1e6;

  return {
    selectedProbability: round(probabilities[selected] ?? 0),
    margin: round((sorted[0] ?? 0) - (sorted[1] ?? 0)),
    normalizedEntropy:
      optionCount <= 1 ? 0 : round(Math.min(1, Math.max(0, entropy / Math.log(optionCount)))),
    optionCount,
  };
}

export interface LedgerOptions {
  /** Appends JSONL here as well as returning records in memory. */
  file?: string;
  component: string;
  mode: RunMode;
  codeVersion?: string;
  /** Overrides the generated run id, e.g. to correlate with an external trace. */
  runId?: string;
}

/** The fields a caller supplies; the ledger fills in the rest. */
export type DecisionInput = Omit<
  DecisionRecord,
  'decisionId' | 'runId' | 'timestamp' | 'mode' | 'component' | 'codeVersion'
>;

export interface Ledger {
  readonly runId: string;
  record(input: DecisionInput): DecisionRecord;
  entries(): readonly DecisionRecord[];
  /** Newline-delimited JSON, one record per line. */
  toJsonl(): string;
}

export function createLedger(options: LedgerOptions): Ledger {
  const runId = options.runId ?? randomUUID();
  const codeVersion = options.codeVersion ?? process.env['GIT_SHA'] ?? 'unversioned-working-tree';
  const entries: DecisionRecord[] = [];

  if (options.file) mkdirSync(dirname(options.file), { recursive: true });

  return {
    runId,
    record(input) {
      const entry: DecisionRecord = {
        decisionId: randomUUID(),
        runId,
        timestamp: new Date().toISOString(),
        mode: options.mode,
        component: options.component,
        codeVersion,
        ...input,
      };
      entries.push(entry);
      if (options.file) appendFileSync(options.file, `${JSON.stringify(entry)}\n`, 'utf8');
      return entry;
    },
    entries: () => entries,
    toJsonl: () => entries.map((entry) => JSON.stringify(entry)).join('\n'),
  };
}

/** A compact one-line summary for terminal output. */
export function summarize(entry: DecisionRecord): string {
  const recommended = entry.recommendation?.choice ?? '(none)';
  const diverged = entry.executed.divergedFromRecommendation ? '  ⚠ diverged' : '';
  return (
    `${entry.policy.route.padEnd(18)} recommended=${recommended.padEnd(28)} ` +
    `executed=${entry.executed.action}${diverged}`
  );
}
