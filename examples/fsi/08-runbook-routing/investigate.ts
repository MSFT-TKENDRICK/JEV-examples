/**
 * The investigation loop's arithmetic: which diagnostic to run next, what it
 * observed, and what the observation does to the distribution.
 *
 * ## The idea this file exists to make concrete
 *
 * The distribution is over **remediations**. What gets selected here is a
 * **diagnostic**. Those are different catalogs, and the link between them is the
 * only interesting thing in this example: a diagnostic is worth running exactly
 * to the extent that its possible observations would *split* the remediation
 * candidates differently. Nothing says which diagnostic to run for which
 * symptom. That falls out of the shape of the prior.
 *
 * It is worth being precise about why a distribution is load-bearing here rather
 * than merely convenient. Expected information gain is
 *
 * ```
 *   EIG(probe) = H(prior) - E_observation[ H(posterior | observation) ]
 * ```
 *
 * For a point estimate, `H(prior) = 0`, and the posterior after any observation
 * is the same point mass, so `H(posterior) = 0` as well. Every term is zero for
 * **every** diagnostic. A model that returns only its best guess does not make
 * this selection harder — it makes every diagnostic exactly as worthless as
 * every other, and there is no tie-break available anywhere, because the
 * quantity being compared is identically zero. `eigIsDegenerate` detects that
 * case, and the example demonstrates it rather than asserting it.
 *
 * ## The budget, and why it has two dimensions
 *
 * `maxProbes` bounds how many diagnostics run. `maxCostUnits` bounds what they
 * may cost in total. The second is what makes ranking on `gainPerCost` mean
 * anything: with an unlimited budget the cheapest and dearest diagnostics are
 * equally available, and the interesting trade — *the sharpest check is not
 * always the one to run first* — never arises.
 *
 * ## What is real and what is authored
 *
 * The entropy arithmetic is real: it is computed by `src/information-gain.ts`
 * over the numbers it is given. Distributions come from Jev in live mode and
 * are manufactured only in explicit offline mode. The partitions
 * that say which observations are consistent with which remediations were
 * written by the same person who wrote the fixtures, so when a probe's predicted
 * posterior lines up with an offline re-judged distribution, that agreement is not
 * evidence of anything — it is one author agreeing with themselves. The example
 * prints both numbers anyway, because a reader who can see them can discount
 * them; a reader shown only a conclusion cannot.
 */

import {
  assess,
  eigIsDegenerate,
  entropy,
  posterior,
  selectProbe,
  type Assessment,
  type Probe,
} from '../../../src/information-gain.ts';
import type { ConsideredProbe } from '../../../src/ledger.ts';
import {
  DIAGNOSTICS_BY_ID,
  DIAGNOSTIC_OBSERVATION_SOURCE,
  diagnosticProbes,
  earliestUnhealthyAncestor,
  type Diagnostic,
} from '../../../src/runbook-catalog.ts';
import type { Incident } from './fixtures.ts';
import { INVESTIGATION } from './policy.ts';

/** Returned when a diagnostic has nothing to say about this incident. */
export const INCONCLUSIVE = 'inconclusive';

export interface BudgetState {
  probesRun: number;
  costSpent: number;
}

export interface Affordability {
  /** Assessed and inside the remaining budget. */
  affordable: readonly Assessment[];
  /**
   * Assessed and outside it.
   *
   * Kept and printed rather than filtered silently, because "the sharpest check
   * available was not run, and here is what it would have been worth" is the
   * part a reader most wants to second-guess.
   */
  unaffordable: readonly Assessment[];
}

export type ProbeChoice =
  | {
      kind: 'probe';
      diagnostic: Diagnostic;
      probe: Probe;
      assessment: Assessment;
      ranked: readonly Assessment[];
      unaffordable: readonly Assessment[];
    }
  | {
      kind: 'stop';
      /** Why no diagnostic is being run. */
      reason: string;
      /** Distinguishes "nothing worth running" from "nothing left we can pay for". */
      cause: 'no_gain' | 'budget_probes' | 'budget_cost' | 'degenerate' | 'none_applicable';
      ranked: readonly Assessment[];
      unaffordable: readonly Assessment[];
    };

/**
 * Assesses every applicable diagnostic and splits it by what the remaining
 * budget can pay for.
 *
 * Exported separately from `chooseProbe` because the degenerate-prior
 * demonstration needs the assessments without the selection: the point there is
 * that every gain is zero, which is a property of the *assessment*, and routing
 * it through a selector that would refuse them all anyway would hide it.
 */
export function assessApplicable(
  prior: Readonly<Record<string, number>>,
  incident: Incident,
  state: BudgetState,
  alreadyRun: readonly string[],
): Affordability {
  const remaining = INVESTIGATION.maxCostUnits - state.costSpent;
  const run = new Set(alreadyRun);
  const assessments = diagnosticProbes(incident.components)
    .filter((probe) => !run.has(probe.id))
    .map((probe) => assess(prior, probe))
    .sort((a, b) => b.gainPerCost - a.gainPerCost);

  return {
    affordable: assessments.filter((a) => a.probe.cost <= remaining),
    unaffordable: assessments.filter((a) => a.probe.cost > remaining),
  };
}

/**
 * Picks the next diagnostic, or explains why none is being run.
 *
 * Budget is checked before gain, deliberately. "We stopped because we had spent
 * what we were willing to spend" and "we stopped because nothing left was worth
 * running" are different statements about a run, and collapsing them would make
 * the refusal fixture indistinguishable from the confident one.
 */
export function chooseProbe(
  prior: Readonly<Record<string, number>>,
  incident: Incident,
  state: BudgetState,
  alreadyRun: readonly string[],
): ProbeChoice {
  const { affordable, unaffordable } = assessApplicable(prior, incident, state, alreadyRun);

  if (state.probesRun >= INVESTIGATION.maxProbes) {
    return {
      kind: 'stop',
      cause: 'budget_probes',
      reason: `probe budget spent (${state.probesRun} of ${INVESTIGATION.maxProbes} diagnostics run)`,
      ranked: affordable,
      unaffordable,
    };
  }

  if (affordable.length === 0) {
    const anyLeft = unaffordable.length > 0;
    return {
      kind: 'stop',
      cause: anyLeft ? 'budget_cost' : 'none_applicable',
      reason: anyLeft
        ? `nothing affordable left: ${INVESTIGATION.maxCostUnits - state.costSpent} of ` +
          `${INVESTIGATION.maxCostUnits} cost units remain and the cheapest unrun diagnostic ` +
          `costs ${Math.min(...unaffordable.map((a) => a.probe.cost))}`
        : 'no unrun diagnostic applies to these configuration items',
      ranked: affordable,
      unaffordable,
    };
  }

  const selection = selectProbe(
    prior,
    affordable.map((a) => a.probe),
    {
      minimumGain: INVESTIGATION.minimumGain,
      minimumGainFraction: INVESTIGATION.minimumGainFraction,
      decisionThreshold: INVESTIGATION.decisionThreshold,
    },
  );

  if (selection.chosen === null) {
    return {
      kind: 'stop',
      cause: selection.degenerate ? 'degenerate' : 'no_gain',
      reason: selection.reason,
      ranked: selection.ranked,
      unaffordable,
    };
  }

  const diagnostic = DIAGNOSTICS_BY_ID.get(selection.chosen.probe.id);
  if (!diagnostic) {
    // Only reachable if the catalog and the probe builder drift apart.
    return {
      kind: 'stop',
      cause: 'none_applicable',
      reason: `selected probe ${selection.chosen.probe.id} is not in the diagnostic catalog`,
      ranked: selection.ranked,
      unaffordable,
    };
  }

  return {
    kind: 'probe',
    diagnostic,
    probe: selection.chosen.probe,
    assessment: selection.chosen,
    ranked: selection.ranked,
    unaffordable,
  };
}

export interface Observation {
  value: string;
  /** `computed` means derived from structured state; `authored` means written down. */
  source: 'computed' | 'authored';
  /** How the value was arrived at, in one line, for the probe trail. */
  derivation: string;
}

/**
 * Runs a diagnostic, read-only.
 *
 * Exactly one branch here does real work. `DG-UPSTREAM-DEPGRAPH` walks the
 * scheduler snapshot and reports what it finds, so its observation is a function
 * of structured state and changes if the snapshot changes. Every other
 * diagnostic returns a string the fixture author wrote, and says so.
 *
 * Diagnostics are read-only because they are *defined* as reads and this
 * function is given no way to write. That is a property of the example, not a
 * guarantee enforced by a sandbox, and a production version of this would need
 * the guarantee to come from somewhere other than a comment.
 */
export function observe(incident: Incident, diagnosticId: string): Observation {
  if (diagnosticId === 'DG-UPSTREAM-DEPGRAPH') {
    const ancestor = earliestUnhealthyAncestor(incident.job);

    if (ancestor === null || ancestor.job === incident.job) {
      return {
        value: 'first-failure-is-this-job',
        source: 'computed',
        derivation:
          ancestor === null
            ? `${incident.job} has no predecessor chain in the flow snapshot`
            : `${incident.job} is itself the earliest job in its chain that did not end cleanly`,
      };
    }

    const bucket =
      ancestor.component === 'FXFEED'
        ? 'first-failure-upstream-feed'
        : ancestor.component === 'CBPOST' || ancestor.component === 'CBSTMT'
          ? 'first-failure-upstream-posting'
          : 'first-failure-upstream-other';

    return {
      value: bucket,
      source: 'computed',
      derivation:
        `${ancestor.job} (${ancestor.component}) is ${ancestor.state}` +
        `${ancestor.endedAt ? ` at ${ancestor.endedAt}` : ''}, upstream of ${incident.job}`,
    };
  }

  const scripted = incident.observations?.[diagnosticId];
  return {
    value: scripted ?? INCONCLUSIVE,
    source: DIAGNOSTIC_OBSERVATION_SOURCE[diagnosticId] ?? 'authored',
    derivation: scripted
      ? 'scripted by the fixture author'
      : 'the fixture scripts no result for this diagnostic',
  };
}

export interface Fold {
  posterior: Record<string, number>;
  priorEntropy: number;
  /**
   * Entropy of the analytic Bayesian update under this observation.
   *
   * This is a *prediction*, and it is recorded so it can be compared against the
   * entropy of the distribution the model actually returns on re-judgement. When
   * the two agree, that is not corroboration: the partition and the re-judged
   * fixture were written by the same author. When they disagree, that is
   * genuinely informative, because it means the scripted narrative and the
   * scripted likelihood model have drifted apart.
   */
  predictedPosteriorEntropy: number;
  /** True when the observation is in no bucket, so the update is a no-op. */
  uninformative: boolean;
}

/** Applies one observation to the distribution, analytically. */
export function fold(
  prior: Readonly<Record<string, number>>,
  probe: Probe,
  observation: string,
): Fold {
  const updated = posterior(prior, probe, observation);
  const priorMasses = Object.values(prior);
  return {
    posterior: updated,
    priorEntropy: entropy(priorMasses),
    predictedPosteriorEntropy: entropy(Object.values(updated)),
    uninformative: !probe.observations.includes(observation),
  };
}

/**
 * The considered set for one probe step, in ranked order and including the probe
 * that was chosen.
 *
 * Recorded on every `ProbeRecord` because probe economy is a counterfactual
 * question — "would a different ordering have got there for less?" — and the
 * orderings not taken are unrecoverable after the run. An absent field means the
 * run did not measure this, never that it passed.
 */
export function consideredFrom(ranked: readonly Assessment[]): ConsideredProbe[] {
  return ranked.map((a) => ({
    probeId: a.probe.id,
    expectedInformationGain: a.expectedInformationGain,
    costUnits: a.probe.cost,
  }));
}

/**
 * Re-exported so the caller can show the degeneracy result without importing the
 * information-gain module directly, and so the point is made at the place the
 * probe loop lives rather than in a footnote.
 */
export { eigIsDegenerate };
