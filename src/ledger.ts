/**
 * The decision ledger.
 *
 * ## What this is
 *
 * One record per Jev-influenced decision, capturing the inputs the application
 * could see, the distribution it received, the policy it applied, **what Jev
 * recommended, and separately what the harness actually did**. That last split is
 * the point. A log that only stores the model's answer cannot later distinguish a
 * model error from a policy bug, a deterministic veto, or an execution failure.
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
 *
 * ## Data minimization is only partly enforced here
 *
 * `StateReference` is structurally minimizing: it stores a hash and field
 * *names*, never values. Nothing else in this module is. `recommendation.question`,
 * `policy.reason`, `failure.detail`, `probes[].observation` and
 * `executed.arguments` are
 * unconstrained strings, and in this domain they are exactly where a merchant
 * name, an amount, a card identifier, a customer narrative or a log excerpt will
 * end up. Callers are responsible for what they put in them; a record is only as
 * minimized as its least careful field.
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { RunMode } from './fixture-label.ts';

/** The service that produced a judgment. Constant for a whole run. */
export interface ServiceIdentity {
  model: string;
  sdkPackage: string;
  sdkVersion: string;
}

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
  /**
   * The route taken, e.g. 'act', 'probe', 'refused', 'rolled_back'.
   *
   * Note what is absent: there is no route that parks a decision in front of a
   * person. Uncertainty routes to `probe` — go and find the evidence that
   * separates the leading candidates — and the loop continues.
   */
  route: string;
  /** Plainly worded reason the route was chosen. */
  reason: string;
}

/** How a call failed, when it did. */
export interface FailureOutcome {
  kind: 'timeout' | 'malformed_response' | 'service_error' | 'stale_state' | 'other';
  detail: string;
  /** What the application did instead. Fail closed where consequential. */
  fallback: string;
}

/**
 * One disambiguation step: the system was torn, worked out what would settle
 * it, went and checked, and updated.
 *
 * This replaces what used to be a record of a human's disposition. The trail
 * matters for the same reason the old field did — you want to know why the
 * final action was taken — but it records machine work rather than a handoff.
 */
export interface ProbeRecord {
  probeId: string;
  /** Expected entropy reduction in nats, computed before running it. */
  expectedInformationGain: number;
  /** Entropy before, so the gain can be read as a fraction of what was there. */
  priorEntropy: number;
  /** What the probe actually returned. */
  observation: string;
  /** Entropy after the update, so a probe that did not help is visible. */
  posteriorEntropy: number;
  costUnits: number;
}

/** Outcome of an act-verify-compensate plan, when one was run. */
export interface ExecutionRecord {
  outcome: 'completed' | 'rolled_back' | 'inconsistent' | 'refused' | 'aborted_before_commit';
  reason: string;
  stepsAttempted: number;
  stepsVerified: number;
  /** Set when compensation failed and the world is in an unintended state. */
  inconsistentAt?: string;
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
  service: ServiceIdentity;
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
  /**
   * The disambiguation trail, oldest first. Empty when the first answer was
   * peaked enough to act on directly.
   */
  probes: ProbeRecord[];
  execution: ExecutionRecord | null;
  failure: FailureOutcome | null;
  latencyMs: number;
}

/** Canonical JSON so equal states hash equally regardless of key order. */
function canonical(value: unknown, path = '$', seen = new Set<object>()): string {
  if (typeof value === 'bigint') {
    throw new Error(`Cannot hash a bigint at ${path}. Convert it to a string first.`);
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`Cannot hash a ${typeof value} at ${path}.`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    // NaN, Infinity and -Infinity all serialize to `null` under JSON.stringify,
    // so allowing them would make distinct states hash identically.
    throw new Error(`Cannot hash the non-finite number ${value} at ${path}.`);
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';

  // Without this, `{at: new Date(...)}` serializes to `{"at":{}}` — every state
  // carrying a different timestamp would hash to the same value. FSI state is
  // full of timestamps, so this is the likely case rather than the exotic one.
  if (value instanceof Date) return JSON.stringify(value.toISOString());

  if (value instanceof Map || value instanceof Set) {
    throw new Error(
      `Cannot hash a ${value.constructor.name} at ${path}; it would serialize to {}. ` +
        'Convert it to a plain object or array first.',
    );
  }

  if (seen.has(value)) throw new Error(`Cannot hash a cyclic reference at ${path}.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item, i) => canonical(item, `${path}[${i}]`, seen)).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v, `${path}.${k}`, seen)}`)
      .join(',')}}`;
  } finally {
    seen.delete(value);
  }
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

/**
 * Derives the statistics a policy should be reasoning about.
 *
 * @param offeredOptionIds - Every option that was *offered*, which is not
 *   necessarily every option the service returned. A truncated or malformed
 *   response returns fewer, and a threshold justified for one option-set size is
 *   not portable to another — so the count must come from what you offered.
 *   Required: when this was optional, omitting it silently changed the entropy
 *   denominator, which is the kind of mistake that reads as correct.
 *
 * Degenerate inputs are treated as maximally *uninformative*, never as
 * confident. A one-option set and an empty distribution would otherwise both
 * report `margin: 1, normalizedEntropy: 0`, and a policy of the shape
 * `entropy <= 0.3 && margin >= 0.4` would auto-approve them. That is the fail-open
 * direction, in exactly the malformed-response path these examples exercise.
 */
export function metricsFor(
  probabilities: Readonly<Record<string, number>>,
  selected: string,
  offeredOptionIds: readonly string[],
): DistributionMetrics {
  const returned = Object.keys(probabilities);
  const optionCount = offeredOptionIds.length;

  if (returned.length > 0 && !(selected in probabilities)) {
    throw new Error(
      `Selected option "${selected}" is not present in the returned distribution ` +
        `(${returned.join(', ')}). This usually means an option-ID/label mismatch.`,
    );
  }

  // Fewer than two options carries no comparative information, so report it as
  // fully ambiguous rather than letting `sorted[1] ?? 0` fake a decisive margin.
  if (returned.length < 2) {
    return { selectedProbability: 0, margin: 0, normalizedEntropy: 1, optionCount };
  }

  const values = Object.values(probabilities);
  const sorted = [...values].sort((a, b) => b - a);
  const entropy = -values.reduce((sum, p) => (p > 0 ? sum + p * Math.log(p) : sum), 0);
  // Derived values are rounded so ledger records stay readable and diffable;
  // raw float subtraction otherwise writes artefacts like 0.21000000000000002.
  const round = (value: number) => Math.round(value * 1e6) / 1e6;

  return {
    selectedProbability: round(probabilities[selected] ?? 0),
    margin: round((sorted[0] ?? 0) - (sorted[1] ?? 0)),
    normalizedEntropy: round(Math.min(1, Math.max(0, entropy / Math.log(returned.length)))),
    optionCount,
  };
}

/**
 * Builds a redacted state reference.
 *
 * Both examples would otherwise write `{ hash: hashState(s), fieldsSent: ... }`
 * by hand at every call site and drift apart.
 */
export function stateReference(
  state: Record<string, unknown>,
  fieldsWithheld?: readonly string[],
): StateReference {
  return {
    hash: hashState(state),
    fieldsSent: Object.keys(state).sort(),
    ...(fieldsWithheld ? { fieldsWithheld } : {}),
  };
}

export interface LedgerOptions {
  /** Appends JSONL here as well as returning records in memory. */
  file?: string;
  component: string;
  mode: RunMode;
  /** Constant per run, and not knowable at an individual call site. */
  service?: ServiceIdentity;
  codeVersion?: string;
  /** Overrides the generated run id, e.g. to correlate with an external trace. */
  runId?: string;
  /** Appends to an existing file instead of truncating it on open. */
  append?: boolean;
}

/**
 * The fields a caller supplies; the ledger fills in the rest.
 *
 * `recommendation`, `metrics`, `probes`, `execution` and `failure` are optional
 * and default to empty or `null`, so a decision that acted on a peaked first
 * answer does not have to write five empty fields.
 * `divergedFromRecommendation` is optional and derived — see `record()`.
 */
export type DecisionInput = Omit<
  DecisionRecord,
  | 'decisionId'
  | 'runId'
  | 'timestamp'
  | 'mode'
  | 'component'
  | 'codeVersion'
  | 'service'
  | 'recommendation'
  | 'metrics'
  | 'probes'
  | 'execution'
  | 'failure'
  | 'executed'
> & {
  service?: ServiceIdentity;
  recommendation?: Recommendation | null;
  metrics?: DistributionMetrics | null;
  probes?: ProbeRecord[];
  execution?: ExecutionRecord | null;
  failure?: FailureOutcome | null;
  executed: Omit<DecisionRecord['executed'], 'divergedFromRecommendation'> & {
    /**
     * Normally derived. Set it only when the executed action lives in a
     * different namespace from the option IDs, and say why in `policy.reason`.
     */
    divergedFromRecommendation?: boolean;
  };
};

export interface Ledger {
  readonly runId: string;
  record(input: DecisionInput): DecisionRecord;
  entries(): readonly DecisionRecord[];
  /** Times `fn`, then records the result with the measured latency. */
  timed<T>(fn: () => Promise<T>): Promise<{ value: T; latencyMs: number }>;
  /** Newline-delimited JSON, one record per line, with a trailing newline. */
  toJsonl(): string;
}

const UNKNOWN_SERVICE: ServiceIdentity = {
  model: 'unknown',
  sdkPackage: '@typesafe-ai/sdk',
  sdkVersion: 'unknown',
};

export function createLedger(options: LedgerOptions): Ledger {
  const runId = options.runId ?? randomUUID();
  const codeVersion = options.codeVersion ?? process.env['GIT_SHA'] ?? 'unversioned-working-tree';
  const entries: DecisionRecord[] = [];

  if (options.file) {
    mkdirSync(dirname(resolve(options.file)), { recursive: true });
    // Truncate on open, or a demo re-run silently accumulates every previous
    // run's records into the same file while `entries()` holds only this one.
    if (!options.append) writeFileSync(options.file, '', 'utf8');
  }

  return {
    runId,
    async timed(fn) {
      const started = performance.now();
      const value = await fn();
      return { value, latencyMs: Math.round(performance.now() - started) };
    },
    record(input) {
      const { service, recommendation, metrics, probes, execution, failure, executed, ...rest } =
        input;
      const recommended = recommendation ?? null;

      const entry: DecisionRecord = {
        // `...rest` goes first deliberately. Spreading caller input last would
        // let it overwrite `mode`, `decisionId` or `runId` — and `mode` is the
        // field the whole scripted-vs-live disclosure rests on. `Omit` does not
        // prevent this, because it only rejects excess properties on object
        // *literals*; a caller passing a variable would silently win.
        ...rest,
        decisionId: randomUUID(),
        runId,
        timestamp: new Date().toISOString(),
        mode: options.mode,
        component: options.component,
        codeVersion,
        service: service ?? options.service ?? UNKNOWN_SERVICE,
        recommendation: recommended,
        metrics: metrics ?? null,
        probes: probes ?? [],
        execution: execution ?? null,
        failure: failure ?? null,
        executed: {
          ...executed,
          // Derived rather than asserted. This is the most load-bearing field in
          // the module, a wrong `false` claims an agreement that never happened,
          // and its meaning when there is no recommendation is exactly where two
          // independent callers would disagree.
          divergedFromRecommendation:
            executed.divergedFromRecommendation ??
            (recommended?.choice === undefined ? false : recommended.choice !== executed.action),
        },
      };

      entries.push(entry);
      if (options.file) {
        try {
          appendFileSync(options.file, `${JSON.stringify(entry)}\n`, 'utf8');
        } catch (error) {
          // A disk problem must not unwind a decision the harness already made.
          console.warn(`ledger: could not write to ${options.file}: ${String(error)}`);
        }
      }
      return entry;
    },
    entries: () => [...entries],
    toJsonl: () => entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
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
