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
 * ## The sweep is counterfactual; the probe trail is not
 *
 * This distinction matters and is easy to lose.
 *
 * Moving a threshold is a **counterfactual**: it asks what the policy would have
 * done to a recorded distribution under a gate that was never actually applied.
 * So the sweep can say a decision would or would not have cleared a given gate,
 * and therefore whether the application would have acted immediately or gone
 * looking for evidence. It **cannot** say what that investigation would have
 * found, because the probes that were run were selected against the real gate,
 * and a different gate would have selected differently. The `investigated`
 * column is therefore a count of decisions that would need evidence — never a
 * prediction that the evidence would arrive.
 *
 * What is not counterfactual is the recorded probe trail. `probes` and
 * `execution` describe what the run actually did at its shipped thresholds, so
 * they are reported separately and are not swept.
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
  /** Of those, how many the gate would let act immediately, with no probing. */
  acted: number;
  /**
   * Of those, how many the gate would send looking for more evidence.
   *
   * This is *not* a count of refusals. A decision that fails the gate goes on to
   * probe, and may well resolve; whether it does is not knowable at a threshold
   * that was never run. See the note on counterfactuals in the header.
   */
  investigated: number;
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
    const acted = scored.filter(
      (r) => passesGate(r, gate) && !isNoneOption(r.recommendation?.choice ?? ''),
    );
    return {
      gate,
      scored: scored.length,
      acted: acted.length,
      investigated: scored.length - acted.length,
      contradicted: acted.filter(deterministicallyContradicted).length,
    };
  });
}

/**
 * What the runs actually did, as opposed to what a swept threshold would have
 * done. Read straight off the recorded probe trail and execution outcome, so
 * unlike the sweep it involves no counterfactual reasoning at all.
 */
export interface ResolutionSummary {
  /** Decisions that reached a usable distribution. */
  scored: number;
  /** Of those, how many needed no probe at all. */
  actedImmediately: number;
  /** How many probed and then went on to execute something. */
  resolvedByProbing: number;
  /** How many probed, ran out of budget, and refused. Nothing was changed. */
  refusedAfterProbing: number;
  /** Total probes spent across every decision. */
  probesSpent: number;
  /** Total cost units spent on probes, in the units the examples authored. */
  probeCost: number;
  /**
   * Total nats of entropy removed, summed over probes.
   *
   * A measure of how much the authored probe set moved the authored priors. It
   * says nothing about calibration: the prior was scripted, so the posterior is
   * a consequence of the script.
   */
  entropyRemoved: number;
  /**
   * Runs that ended with partial effects the compensator could not undo.
   *
   * Should be zero, and is reported precisely so that it is visible when it is
   * not. `inconsistent` is a loud failure, never a synonym for handled.
   */
  inconsistent: number;
}

export function resolution(records: readonly DecisionRecord[]): ResolutionSummary {
  const scored = records.filter(scoreable);
  const probed = scored.filter((r) => r.probes.length > 0);

  return {
    scored: scored.length,
    actedImmediately: scored.filter((r) => r.probes.length === 0).length,
    resolvedByProbing: probed.filter((r) => r.execution?.outcome === 'completed').length,
    refusedAfterProbing: probed.filter((r) => r.execution?.outcome === 'refused').length,
    probesSpent: scored.reduce((total, r) => total + r.probes.length, 0),
    probeCost: scored.reduce(
      (total, r) => total + r.probes.reduce((sum, p) => sum + p.costUnits, 0),
      0,
    ),
    entropyRemoved: scored.reduce(
      (total, r) =>
        total + r.probes.reduce((sum, p) => sum + (p.priorEntropy - p.posteriorEntropy), 0),
      0,
    ),
    inconsistent: scored.filter((r) => r.execution?.outcome === 'inconsistent').length,
  };
}

/**
 * What EIG-ordered probe selection cost, and what it bought, against the
 * obvious alternative of just running the cheapest probe available.
 *
 * Read only from `ProbeRecord.considered`, which records the option set as it
 * was assessed at that step.
 *
 * **This is deliberately per-step and myopic, and it does not extrapolate.**
 * The tempting version of this metric sums the cheapest probe's cost at every
 * step and reports it as "what cheapest-first would have spent". That number
 * would be wrong: picking a different probe at step one produces a different
 * observation, a different posterior, and therefore a different option set at
 * step two. Only the first step of the alternative trajectory is knowable from
 * a trail the alternative did not generate. So every figure here compares the
 * two policies *at the same recorded step*, and none of them claims a total.
 */
export interface ProbeEconomy {
  /** Probe steps seen in total. */
  steps: number;
  /** Steps whose option set had more than one probe, so a choice existed. */
  measurable: number;
  /**
   * Steps that recorded no option set at all — `considered` absent or empty.
   *
   * Genuinely unknown: the alternatives existed at run time and were not
   * written down, so the comparison cannot be made from this trail at all.
   * Reported rather than dropped, so the denominator stays honest, and never
   * counted as a pass.
   */
  unmeasured: number;
  /**
   * Steps that recorded exactly one option, so no choice existed.
   *
   * This is a *measured* fact and must not be folded into `unmeasured`. The
   * trail is complete here; it simply shows the selector had nothing to choose
   * between. Calling that unmeasured would send a reader looking for a missing
   * record that was in fact written.
   */
  noAlternatives: number;
  /** Measurable steps where cheapest-first would have run a different probe. */
  disagreements: number;
  /**
   * At disagreeing steps, mean of (chosen cost / cheapest cost).
   *
   * Above 1 means EIG selection is paying a premium. This is the honest cost
   * of the sophistication, and it is the number most likely to be unflattering.
   */
  meanCostMultiplier: number | null;
  /**
   * At disagreeing steps, mean of (chosen gain / cheapest gain).
   *
   * Above 1 means the premium bought more information. Compare against
   * `meanCostMultiplier`: buying 1.1x the information for 3x the cost is a
   * loss, and the table should be able to show that.
   */
  meanGainMultiplier: null | number;
  /**
   * Steps where the cheapest probe had a strictly better gain-per-cost than
   * the probe actually chosen.
   *
   * Under the shipped `byCostEfficiency` ranking this is zero by construction,
   * so it is a consistency check on the recorded trail, not evidence that the
   * selector is good. A non-zero value means the trail and the ranking rule
   * disagree — a bug in the example, not an interesting result.
   */
  rankingViolations: number;
}

function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator <= 0) return null;
  return numerator / denominator;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, v) => total + v, 0) / values.length;
}

export function probeEconomy(records: readonly DecisionRecord[]): ProbeEconomy {
  let steps = 0;
  let unmeasured = 0;
  let noAlternatives = 0;
  let disagreements = 0;
  let rankingViolations = 0;
  const costMultipliers: number[] = [];
  const gainMultipliers: number[] = [];

  for (const record of records.filter(scoreable)) {
    for (const probe of record.probes) {
      steps += 1;
      const options = probe.considered ?? [];

      // No record of the option set is unknown. A recorded set of one is known,
      // and says there was nothing to choose between. Different facts.
      if (options.length === 0) {
        unmeasured += 1;
        continue;
      }
      if (options.length === 1) {
        noAlternatives += 1;
        continue;
      }

      const cheapest = options.reduce((best, o) => (o.costUnits < best.costUnits ? o : best));
      if (cheapest.probeId === probe.probeId) continue;

      disagreements += 1;

      const costMultiple = ratio(probe.costUnits, cheapest.costUnits);
      if (costMultiple !== null) costMultipliers.push(costMultiple);

      const gainMultiple = ratio(probe.expectedInformationGain, cheapest.expectedInformationGain);
      if (gainMultiple !== null) gainMultipliers.push(gainMultiple);

      const chosenEfficiency = ratio(probe.expectedInformationGain, probe.costUnits);
      const cheapestEfficiency = ratio(cheapest.expectedInformationGain, cheapest.costUnits);
      if (
        chosenEfficiency !== null &&
        cheapestEfficiency !== null &&
        cheapestEfficiency > chosenEfficiency
      ) {
        rankingViolations += 1;
      }
    }
  }

  return {
    steps,
    measurable: steps - unmeasured - noAlternatives,
    unmeasured,
    noAlternatives,
    disagreements,
    meanCostMultiplier: mean(costMultipliers),
    meanGainMultiplier: mean(gainMultipliers),
    rankingViolations,
  };
}

/**
 * Sweeps the mass threshold across its useful range, holding the other two at
 * the values the examples actually ship. Varying one knob at a time is the only
 * way the resulting column is attributable to anything.
 *
 * The probe-side thresholds an example may carry — a probe budget, a minimum
 * gain worth buying — are not represented here at all. So the output is the
 * sensitivity of one gate, and must not be described as the sensitivity of the
 * policy.
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
