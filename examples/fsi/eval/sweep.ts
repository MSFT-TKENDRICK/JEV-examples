/**
 * Threshold sensitivity analysis.
 *
 * ## What this measures
 *
 * How the **policy** routes decisions as its thresholds move. Nothing else.
 *
 * ## What it cannot measure, and why
 *
 * There is no accuracy column here, and its absence is deliberate. Measuring
 * accuracy needs a correct answer per case, and this repository does not have
 * one. Example 08's fixtures say so in as many words — `fixtureNote` is
 * documented as "Not a claim about what the right answer is" — and example 07's
 * `label` is one author's expectation committed before the run, which is a prior
 * rather than a ground truth. Scoring against either would mean inventing the
 * very evidence the repository says it does not have.
 *
 * It is worth being blunt about the deeper reason. Every distribution swept here
 * was manufactured by `src/mock-fetch.ts`, which scripts the selected answer
 * *and* the shape of the distribution. An accuracy number computed over
 * manufactured distributions would measure the fixture author, not the model.
 *
 * ## The one safety signal that is real
 *
 * `contradicted` counts decisions where the distribution gate **passed** and the
 * harness still did not execute the recommendation. That can only happen when a
 * deterministic check — revalidation against authoritative state, argument
 * binding, an eligibility recompute — vetoed an answer the thresholds had
 * already accepted.
 *
 * It is computed, not labelled: it falls out of comparing the recorded metrics
 * against the recorded thresholds and then reading `divergedFromRecommendation`.
 * No human wrote down a correct answer anywhere in that chain, which is exactly
 * why it is the only column here that carries real weight.
 */

import type { DecisionRecord } from '../../../src/ledger.ts';
import type { ExampleRun } from './collect.ts';

/** The gate both example policies share. 08 adds a fourth test of its own. */
export interface Gate {
  minSelectedProbability: number;
  minMargin: number;
  maxNormalizedEntropy: number;
}

export interface SweepRow {
  gate: Gate;
  /** Decisions that reached a request and returned a usable distribution. */
  scored: number;
  /** Of those, how many the gate would accept. */
  accepted: number;
  /** Of those, how many the gate would send to a human. */
  escalated: number;
  /** Accepted decisions that a deterministic check nonetheless vetoed. */
  contradicted: number;
}

/**
 * A decision is scoreable only if it produced both metrics and a distribution.
 * Timeouts, malformed responses and outright service failures are excluded —
 * not because they do not matter, but because a threshold cannot act on an
 * answer that never arrived. The examples route those on their own.
 */
export function scoreable(record: DecisionRecord): boolean {
  return record.metrics !== null && record.recommendation?.choice !== undefined;
}

/**
 * `none-of-these` is the model declining the catalog, not a deterministic veto,
 * so it must not be counted as one. Both examples spell it, reasonably, in their
 * own house style.
 */
function isNoneOption(choice: string): boolean {
  return /^none[-_]of[-_]these$/i.test(choice);
}

function passesGate(record: DecisionRecord, gate: Gate): boolean {
  const m = record.metrics;
  if (m === null) return false;
  return (
    m.selectedProbability >= gate.minSelectedProbability &&
    m.margin >= gate.minMargin &&
    m.normalizedEntropy <= gate.maxNormalizedEntropy
  );
}

/**
 * True when a deterministic check overrode an answer the thresholds accepted.
 *
 * Derived entirely from what the run recorded: the decision cleared its own
 * policy's thresholds, it was not the model declining via `none-of-these`, and
 * the harness still executed something other than the recommendation.
 */
export function deterministicallyContradicted(record: DecisionRecord): boolean {
  const choice = record.recommendation?.choice;
  if (choice === undefined || isNoneOption(choice)) return false;

  const recorded = record.policy.thresholds;
  const clearedItsOwnGate = passesGate(record, {
    minSelectedProbability: recorded['minSelectedProbability'] ?? 0,
    minMargin: recorded['minMargin'] ?? 0,
    maxNormalizedEntropy: recorded['maxNormalizedEntropy'] ?? 1,
  });

  return clearedItsOwnGate && record.executed.divergedFromRecommendation;
}

export function sweep(records: readonly DecisionRecord[], gates: readonly Gate[]): SweepRow[] {
  const scored = records.filter(scoreable);

  return gates.map((gate) => {
    const accepted = scored.filter(
      (r) => passesGate(r, gate) && !isNoneOption(r.recommendation?.choice ?? ''),
    );
    return {
      gate,
      scored: scored.length,
      accepted: accepted.length,
      escalated: scored.length - accepted.length,
      contradicted: accepted.filter(deterministicallyContradicted).length,
    };
  });
}

/**
 * Sweeps the mass threshold across its useful range, holding the other two at
 * the values the examples actually ship. Varying one knob at a time is the only
 * way the resulting column is attributable to anything.
 */
export function defaultGates(): Gate[] {
  const gates: Gate[] = [];
  for (let p = 0.5; p <= 0.951; p += 0.05) {
    gates.push({
      minSelectedProbability: Math.round(p * 100) / 100,
      minMargin: 0.25,
      maxNormalizedEntropy: 0.6,
    });
  }
  return gates;
}

export interface Contradiction {
  run: ExampleRun;
  record: DecisionRecord;
}

/** The individual contradicted decisions, so the count can be checked by hand. */
export function contradictions(runs: readonly ExampleRun[]): Contradiction[] {
  return runs.flatMap((run) =>
    run.records
      .filter((record) => scoreable(record) && deterministicallyContradicted(record))
      .map((record) => ({ run, record })),
  );
}
