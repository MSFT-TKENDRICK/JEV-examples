/**
 * The investigation loop: turn a flat distribution into the next question.
 *
 * This is the generic half of the pattern both examples use. It owns none of
 * the domain — it does not know what a candidate is, what a probe asks, or how
 * an answer becomes an observation. It only knows the control flow:
 *
 *     while the leader is not separated enough:
 *       if the budget is spent            -> stop, unresolved
 *       pick the probe with the best gain per unit cost   (selectProbe)
 *       if no probe earns its cost        -> stop, unresolved
 *       if the best probe is unaffordable -> stop, unresolved
 *       run it, fold the observation in   (posterior)
 *
 * Three endings, and all three are machine endings. `resolved` means the
 * distribution concentrated and the caller may act. `unresolved` means it did
 * not, and the caller must change nothing — it is a refusal, terminal, and it
 * does not assume anyone is watching.
 *
 * What is authored and what is computed, because that distinction is the whole
 * honesty question: the probes, their costs, and how their observations
 * partition the candidates are supplied by the caller and, in this repository,
 * written by hand. The ranking over them is computed here from the prior by
 * `selectProbe`, and the update is Bayes. Real arithmetic over manufactured
 * inputs.
 *
 * The selection is greedy and looks one probe ahead. A plan that looked two
 * ahead could beat it, and nothing here claims the sequence is optimal.
 */

import { entropy, posterior, selectProbe, type Assessment, type Probe } from '../information-gain.ts';

export interface Leader {
  candidate: string;
  mass: number;
}

/** Highest-mass candidate. Ties break on key order, which is good enough here. */
export function leader(distribution: Readonly<Record<string, number>>): Leader {
  let best: Leader = { candidate: '', mass: -1 };
  for (const [candidate, mass] of Object.entries(distribution)) {
    if (mass > best.mass) best = { candidate, mass };
  }
  return best;
}

/** Candidates still holding meaningful mass. */
export function support(distribution: Readonly<Record<string, number>>, floor = 1e-6): string[] {
  return Object.entries(distribution)
    .filter(([, mass]) => mass > floor)
    .map(([candidate]) => candidate);
}

/** Renormalizes to sum 1, so thresholds mean what they say. */
export function normalize(distribution: Readonly<Record<string, number>>): Record<string, number> {
  let total = 0;
  for (const mass of Object.values(distribution)) total += Math.max(mass, 0);
  if (total <= 0) return { ...distribution };

  const out: Record<string, number> = {};
  for (const [candidate, mass] of Object.entries(distribution)) {
    out[candidate] = Math.max(mass, 0) / total;
  }
  return out;
}

export interface RankedProbe {
  probeId: string;
  gain: number;
  gainPerCost: number;
  cost: number;
}

export interface InvestigationStep {
  probeId: string;
  description: string | undefined;
  cost: number;
  expectedGain: number;
  priorEntropy: number;
  expectedPosteriorEntropy: number;
  /** Entropy actually left after the observation came back, which is not the expectation. */
  actualPosteriorEntropy: number;
  observation: string;
  /** Every probe considered at this step, best first. Kept so the choice is second-guessable. */
  ranked: RankedProbe[];
  before: Leader;
  after: Leader;
}

export type Resolution =
  | { kind: 'resolved'; candidate: string; mass: number; reason: string }
  | { kind: 'unresolved'; leader: string; mass: number; reason: string };

export interface Investigation {
  prior: Record<string, number>;
  posterior: Record<string, number>;
  trail: InvestigationStep[];
  /** Total probe cost spent, in the caller's units. */
  spent: number;
  resolution: Resolution;
  /** True when the prior was a point mass, so no probe could have gained anything. */
  degenerate: boolean;
}

/** Runs a probe and reports which observation came back. */
export type RunProbe = (probe: Probe) => Promise<string>;

export interface InvestigateOptions {
  /** Stop and act once the leader holds at least this much mass. */
  decisionThreshold: number;
  /** Total probe cost available. A probe that would exceed it is not run. */
  budget: number;
  /** Minimum gain in nats worth paying for at all. */
  minimumGain?: number;
}

function rank(assessments: readonly Assessment[]): RankedProbe[] {
  return assessments.map((assessment) => ({
    probeId: assessment.probe.id,
    gain: assessment.expectedInformationGain,
    gainPerCost: assessment.gainPerCost,
    cost: assessment.probe.cost,
  }));
}

export async function investigate(
  rawPrior: Readonly<Record<string, number>>,
  probes: readonly Probe[],
  run: RunProbe,
  options: InvestigateOptions,
): Promise<Investigation> {
  const { decisionThreshold, budget, minimumGain = 0.05 } = options;

  const prior = normalize(rawPrior);
  const trail: InvestigationStep[] = [];
  const used: string[] = [];
  let current = prior;
  let spent = 0;

  const stop = (resolution: Resolution, degenerate = false): Investigation => ({
    prior,
    posterior: current,
    trail,
    spent,
    degenerate,
    resolution,
  });

  for (;;) {
    const before = leader(current);

    if (before.mass >= decisionThreshold) {
      return stop({
        kind: 'resolved',
        candidate: before.candidate,
        mass: before.mass,
        reason:
          trail.length === 0
            ? `leader holds ${before.mass.toFixed(2)} from the first answer alone — no probe needed`
            : `leader holds ${before.mass.toFixed(2)} after ${trail.length} probe(s) costing ${spent}`,
      });
    }

    if (spent >= budget) {
      return stop({
        kind: 'unresolved',
        leader: before.candidate,
        mass: before.mass,
        reason: `probe budget of ${budget} is spent and the leader still holds only ${before.mass.toFixed(2)}`,
      });
    }

    const selection = selectProbe(current, probes, { exclude: used, minimumGain });

    // Unreachable while `decisionThreshold <= 1`, because a point mass has a
    // leader of 1 and would have resolved above. Handled anyway, so the
    // condition can never be silently reported as a budget failure.
    if (selection.degenerate) {
      return stop(
        { kind: 'unresolved', leader: before.candidate, mass: before.mass, reason: selection.reason },
        true,
      );
    }

    if (selection.chosen === null) {
      return stop({
        kind: 'unresolved',
        leader: before.candidate,
        mass: before.mass,
        reason: selection.reason,
      });
    }

    const chosen = selection.chosen;
    if (spent + chosen.probe.cost > budget) {
      return stop({
        kind: 'unresolved',
        leader: before.candidate,
        mass: before.mass,
        reason:
          `the best remaining probe (${chosen.probe.id}) costs ${chosen.probe.cost} and only ` +
          `${(budget - spent).toFixed(1)} of the ${budget} budget is left`,
      });
    }

    const observation = await run(chosen.probe);
    const updated = posterior(current, chosen.probe, observation);
    const after = leader(updated);

    trail.push({
      probeId: chosen.probe.id,
      description: chosen.probe.description,
      cost: chosen.probe.cost,
      expectedGain: chosen.expectedInformationGain,
      priorEntropy: chosen.priorEntropy,
      expectedPosteriorEntropy: chosen.expectedPosteriorEntropy,
      actualPosteriorEntropy: entropy(Object.values(updated)),
      observation,
      ranked: rank(selection.ranked),
      before,
      after,
    });

    used.push(chosen.probe.id);
    spent += chosen.probe.cost;
    current = updated;
  }
}
