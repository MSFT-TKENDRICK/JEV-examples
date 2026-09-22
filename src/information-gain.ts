/**
 * Expected information gain over a set of probes.
 *
 * This is the file that justifies asking for a distribution instead of an
 * answer, so it is worth being precise about what it computes.
 *
 * You have candidate actions and a probability distribution over them. You also
 * have probes — cheap, read-only things you could check first. Each probe has a
 * set of possible observations, and a likelihood model saying how likely each
 * observation is under each candidate. Standard Bayesian experimental design
 * then gives you, for each probe, how much entropy you expect to remove by
 * running it:
 *
 *     EIG(probe) = H(P) - E_observation[ H(P | observation) ]
 *
 * Pick the probe that maximizes that, run it, update, repeat. No human is
 * consulted at any point: the model's uncertainty is what *selects the next
 * machine action*.
 *
 * The part worth internalizing is what happens without a distribution. A model
 * that returns only its best answer is, in this formalism, a distribution with
 * all mass on one candidate. Then H(P) = 0, and since entropy is non-negative
 * and the posterior of a point mass is still that same point mass, every term
 * is zero:
 *
 *     EIG(probe) = 0 - 0 = 0,  for every probe.
 *
 * So a point estimate does not merely make probe selection harder. It makes
 * every probe look exactly equally worthless, which is to say it removes the
 * ability to choose one on any principled basis at all. `eigIsDegenerate()`
 * below detects that case explicitly, because it is the comparison the examples
 * are built to draw.
 *
 * Nothing here is a claim that Jev's probabilities are calibrated. If they are
 * badly calibrated, this machinery will confidently select a useless probe. It
 * is a claim about what the surrounding program can compute *given* a
 * distribution, and cannot compute without one.
 */

/** Natural-log entropy of a distribution. Ignores zero and negative mass. */
export function entropy(masses: readonly number[]): number {
  let total = 0;
  for (const p of masses) if (p > 0) total += p;
  if (total <= 0) return 0;

  let sum = 0;
  for (const p of masses) {
    if (p <= 0) continue;
    const normalized = p / total;
    sum -= normalized * Math.log(normalized);
  }
  return sum;
}

/** Entropy scaled to [0,1] against a uniform distribution of the same size. */
export function normalizedEntropy(masses: readonly number[]): number {
  const support = masses.filter((p) => p > 0).length;
  if (support <= 1) return 0;
  return entropy(masses) / Math.log(masses.length);
}

/**
 * How likely each observation is, under each candidate.
 *
 * `likelihood[candidateId][observation]` should sum to 1 across observations
 * for a given candidate. `probe()` renormalizes if it does not, so a partition
 * written as 1s and 0s works without ceremony.
 */
export interface Probe {
  id: string;
  /** What running it costs, in whatever unit the caller is budgeting. */
  cost: number;
  observations: readonly string[];
  likelihood: Readonly<Record<string, Readonly<Record<string, number>>>>;
  description?: string;
}

/**
 * Builds a probe from a partition: each observation lists the candidates that
 * would produce it. This is the common case — a diagnostic that cleanly splits
 * the candidate set — and avoids writing out a likelihood matrix by hand.
 *
 * A candidate absent from every bucket is treated as uninformative for this
 * probe (uniform across observations) rather than impossible, so that
 * forgetting to list one degrades the probe's apparent value instead of
 * silently driving that candidate's posterior to zero.
 */
export function partitionProbe(
  id: string,
  cost: number,
  buckets: Readonly<Record<string, readonly string[]>>,
  description?: string,
): Probe {
  const observations = Object.keys(buckets);
  const likelihood: Record<string, Record<string, number>> = {};

  for (const [observation, candidates] of Object.entries(buckets)) {
    for (const candidate of candidates) {
      likelihood[candidate] ??= {};
      likelihood[candidate][observation] = 1;
    }
  }
  for (const row of Object.values(likelihood)) {
    for (const observation of observations) row[observation] ??= 0;
  }

  return { id, cost, observations, likelihood, description };
}

function likelihoodFor(probe: Probe, candidate: string, observation: string): number {
  const row = probe.likelihood[candidate];
  if (row === undefined) return 1 / probe.observations.length;

  let total = 0;
  for (const value of Object.values(row)) total += Math.max(value, 0);
  if (total <= 0) return 1 / probe.observations.length;

  return Math.max(row[observation] ?? 0, 0) / total;
}

export interface Assessment {
  probe: Probe;
  /** Expected entropy removed, in nats. Never negative, up to rounding. */
  expectedInformationGain: number;
  /** Gain per unit cost, which is what you usually actually want to rank on. */
  gainPerCost: number;
  priorEntropy: number;
  expectedPosteriorEntropy: number;
}

/** Posterior over candidates after observing `observation` from `probe`. */
export function posterior(
  prior: Readonly<Record<string, number>>,
  probe: Probe,
  observation: string,
): Record<string, number> {
  const weighted: Record<string, number> = {};
  let total = 0;

  for (const [candidate, mass] of Object.entries(prior)) {
    const value = Math.max(mass, 0) * likelihoodFor(probe, candidate, observation);
    weighted[candidate] = value;
    total += value;
  }

  // An observation no candidate predicts tells you nothing you can act on, so
  // fall back to the prior rather than dividing by zero.
  if (total <= 0) return { ...prior };

  for (const candidate of Object.keys(weighted)) {
    weighted[candidate] = (weighted[candidate] ?? 0) / total;
  }
  return weighted;
}

/** Evaluates one probe against a prior. */
export function assess(prior: Readonly<Record<string, number>>, probe: Probe): Assessment {
  const masses = Object.values(prior);
  const priorEntropy = entropy(masses);

  let expectedPosteriorEntropy = 0;
  for (const observation of probe.observations) {
    let probability = 0;
    for (const [candidate, mass] of Object.entries(prior)) {
      probability += Math.max(mass, 0) * likelihoodFor(probe, candidate, observation);
    }
    if (probability <= 0) continue;

    const after = posterior(prior, probe, observation);
    expectedPosteriorEntropy += probability * entropy(Object.values(after));
  }

  const gain = Math.max(priorEntropy - expectedPosteriorEntropy, 0);
  return {
    probe,
    expectedInformationGain: gain,
    gainPerCost: probe.cost > 0 ? gain / probe.cost : gain,
    priorEntropy,
    expectedPosteriorEntropy,
  };
}

/**
 * True when no probe can tell you anything, which is the case a point-estimate
 * model always lands in.
 *
 * Reported separately from "no good probe" because the two want different
 * handling: a degenerate prior means probing is formally pointless, whereas
 * merely weak probes mean the available diagnostics are bad.
 */
export function eigIsDegenerate(prior: Readonly<Record<string, number>>): boolean {
  return entropy(Object.values(prior)) <= 1e-9;
}

export interface SelectOptions {
  /** Minimum gain in nats worth paying for. Below this, act instead of probing. */
  minimumGain?: number;
  /**
   * Minimum gain as a fraction of prior entropy. Scale-independent, and usually
   * the more meaningful of the two: removing 0.1 nats means something very
   * different against a prior of 0.15 nats than against one of 2.0.
   */
  minimumGainFraction?: number;
  /**
   * Stop and act once the leading candidate holds at least this much mass,
   * whatever the available gain.
   *
   * This is a budget rule, not an optimality result. A cheap probe against a
   * 0.97 leader can still carry real expected gain, because the 3% branch would
   * genuinely change the answer. What this encodes is that you have decided
   * that flip is not worth paying to find, which is a policy choice and belongs
   * to the caller rather than to this file.
   */
  decisionThreshold?: number;
  /** Probes already run, excluded from selection. */
  exclude?: readonly string[];
  /** Rank on gain per unit cost rather than raw gain. Default true. */
  byCostEfficiency?: boolean;
}

export interface Selection {
  chosen: Assessment | null;
  ranked: readonly Assessment[];
  /** Set when the prior carries no entropy for any probe to remove. */
  degenerate: boolean;
  reason: string;
}

/**
 * Picks the probe worth running next, or none.
 *
 * Returning `null` is a real answer and the common one: once the distribution
 * is peaked enough, no probe earns its cost and the right move is to act.
 */
export function selectProbe(
  prior: Readonly<Record<string, number>>,
  probes: readonly Probe[],
  options: SelectOptions = {},
): Selection {
  const {
    minimumGain = 0.05,
    minimumGainFraction = 0,
    decisionThreshold,
    exclude = [],
    byCostEfficiency = true,
  } = options;

  if (eigIsDegenerate(prior)) {
    return {
      chosen: null,
      ranked: [],
      degenerate: true,
      reason:
        'prior carries no entropy, so every probe has zero expected gain — ' +
        'nothing to disambiguate, or nothing that can express being torn',
    };
  }

  if (decisionThreshold !== undefined) {
    const leader = Math.max(...Object.values(prior).map((mass) => Math.max(mass, 0)));
    if (leader >= decisionThreshold) {
      return {
        chosen: null,
        ranked: [],
        degenerate: false,
        reason: `leader holds ${leader.toFixed(2)} mass, at or above the ${decisionThreshold} decision threshold — act`,
      };
    }
  }

  const available = probes.filter((probe) => !exclude.includes(probe.id));
  if (available.length === 0) {
    return { chosen: null, ranked: [], degenerate: false, reason: 'no probes left to run' };
  }

  const ranked = available
    .map((probe) => assess(prior, probe))
    .sort((a, b) =>
      byCostEfficiency ? b.gainPerCost - a.gainPerCost : b.expectedInformationGain - a.expectedInformationGain,
    );

  const best = ranked[0];
  if (best === undefined) {
    return { chosen: null, ranked, degenerate: false, reason: 'no probes left to run' };
  }

  const fractionFloor = minimumGainFraction * best.priorEntropy;
  const floor = Math.max(minimumGain, fractionFloor);

  if (best.expectedInformationGain < floor) {
    return {
      chosen: null,
      ranked,
      degenerate: false,
      reason: `best probe gains ${best.expectedInformationGain.toFixed(3)} nats, below the ${floor.toFixed(3)} floor — act on what you have`,
    };
  }

  return {
    chosen: best,
    ranked,
    degenerate: false,
    reason: `${best.probe.id} expected to remove ${best.expectedInformationGain.toFixed(3)} of ${best.priorEntropy.toFixed(3)} nats`,
  };
}
