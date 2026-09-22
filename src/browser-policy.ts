/**
 * The browser-use policy, shared verbatim by the simulated example (04), the
 * real-Chrome example (05) and the comparison (06).
 *
 * Splitting it out makes the claim of those examples testable: the questions
 * asked and the rules applied to the answers do not depend on whether the page
 * is a literal object or a live DOM. Only `describe` and `act` change.
 *
 * WHAT REPLACED WHAT
 *
 * This file used to end ambiguity with `escalate` and a shortlist, on the
 * reasoning that a shortlist is more honest than a guess. The shortlist part
 * was right and the conclusion was wrong: handing a flat distribution to a
 * person demonstrates a model that defers, and converts an automation problem
 * into a queue. The rule now is the one in `docs/CLAIM-CONTRACTS.md`:
 *
 *     Uncertainty selects the next machine action. It never selects a person.
 *
 * So a flat distribution has exactly three outs, and all three are in `decide`:
 *
 *   probe      run the read-only check with the highest expected information
 *              gain per unit cost, observe, re-judge. Chosen by arithmetic in
 *              `src/information-gain.ts`, not by a rule written here.
 *   backtrack  abandon this path and resume from the best surviving alternative
 *              on the frontier - which exists only because a distribution
 *              ranked the roads not taken.
 *   refuse     stop, say why, having changed nothing. Terminal. It does not
 *              create a work item and does not assume anyone is watching.
 *
 * There is deliberately no fourth option, and in particular no "act on the
 * leader anyway because the budget ran out".
 */

import { choice, noul } from '@typesafe-ai/sdk';
import type { Probe, Selection } from './information-gain.ts';
import { selectProbe } from './information-gain.ts';

/** One interactive element the driver found on the page. */
export interface PageElement {
  id: string;
  role: 'button' | 'link' | 'tab' | 'input';
  label: string;
  /** A point of no return. Code decides this, from the DOM, never the model. */
  irreversible?: boolean;
  /** Incidental page metadata, readable by a peek without navigating. */
  badge?: string;
}

/** What `describe` produces: a compact page, never raw HTML. */
export interface PageSnapshot {
  url: string;
  text: string;
  elements: PageElement[];
}

/**
 * How a run ended.
 *
 * Note what is absent. There is no `ambiguous`, no `needs_confirmation`, no
 * status meaning "a person should look at this". `refused` and `no_path` are
 * ends of the program, not the beginning of someone's afternoon.
 */
export type Status =
  | 'running'
  | 'goal_reached'
  | 'refused'
  | 'probes_exhausted'
  | 'no_path'
  | 'max_steps';

/**
 * The questions, built per page because the option set *is* the page.
 *
 * `none` matters: without an explicit escape hatch the model is forced to
 * nominate an element even when nothing on the page helps, and an agent that
 * cannot say "nothing here" cannot recognise a dead end.
 *
 * There is no question asking which probe to run. Probe selection is computed
 * from the distribution and the probes' likelihood models; asking a model to
 * pick its own diagnostic would make the expected-information-gain machinery
 * decorative.
 */
export function buildQuestions(elements: readonly PageElement[]) {
  const candidates: Record<string, string> = Object.fromEntries(
    elements.map((element) => [element.id, `${element.role} labelled "${element.label}"`]),
  );

  return {
    target: choice(
      'Which single element in `candidates` most likely leads towards completing `task`?',
      { ...candidates, none: 'No element on this page advances the task' },
    ),
    goalMet: noul('Does `visibleText` confirm that `task` has already been completed?', {
      true: 'The page confirms the requested action was carried out',
      false: 'No such confirmation is shown',
    }),
    atTarget: noul('Is this the page on which `task` is finally carried out?', {
      true: 'This page carries the control that performs the requested action',
      false: 'The action is performed somewhere else',
    }),
    deadEnd: noul('Does `visibleText` state that what `task` needs is NOT reachable from here?', {
      true: 'The page rules out this route explicitly, not merely by omission',
      false: 'The route may still continue',
    }),
  };
}

/**
 * Thresholds, gathered so they are obviously tunable and obviously policy.
 *
 * None of these is derived from anything. They are the caller's risk appetite
 * written down, which is exactly where that decision belongs.
 */
export const THRESHOLDS = {
  /** The task is confirmed complete. */
  goalMet: 0.85,
  /** The page has *ruled out* this route. Deliberately high: a dead end must be proven. */
  deadEnd: 0.7,
  /** This is the page where the action happens. */
  atTarget: 0.8,
  /** Below this leader mass, do not navigate. Probe, backtrack, or refuse. */
  navigate: 0.6,
  /**
   * Leader mass required before an irreversible step may run.
   *
   * Higher than `navigate` because a wrong navigation costs a page load and a
   * backtrack, and a wrong submit cannot be taken back at all. The asymmetry is
   * the whole reason the irreversible step goes last.
   */
  commit: 0.9,
} as const;

/** Probe-cost units a single run may spend before it has to stop. */
export const PROBE_BUDGET = 8;

export type Route =
  | { kind: 'complete'; reason: string }
  | { kind: 'commit'; reason: string; leader: string; probability: number }
  | { kind: 'probe'; probeId: string; cost: number; selection: Selection; reason: string }
  | { kind: 'navigate'; elementId: string; probability: number; reason: string }
  | { kind: 'backtrack'; reason: string }
  | { kind: 'refuse'; status: Exclude<Status, 'running' | 'goal_reached'>; reason: string };

export interface Signals {
  goalMet: number;
  atTarget: number;
  deadEnd: number;
}

export interface DecisionInput {
  /**
   * Current belief over element ids, including `none`.
   *
   * This is Jev's distribution on the first look at a page, and the Bayesian
   * posterior after each probe. Passing the working belief rather than the raw
   * answer is what lets a probe genuinely change the decision instead of merely
   * being reported next to it.
   */
  prior: Readonly<Record<string, number>>;
  signals: Signals;
  /** Probes still available on this page, already-run ones removed. */
  probes: readonly Probe[];
  /** Probe-cost units left in this run. */
  budget: number;
  /** Whether the frontier still holds an untried alternative path. */
  hasAlternative: boolean;
  /** Ids the caller will not navigate to, e.g. already-visited pages. */
  exclude?: readonly string[];
  /**
   * Ids of elements that cannot be undone.
   *
   * Excluded from ordinary navigation entirely. The only route that may select
   * one is `commit`, and only once the commit gate has opened. This is a code
   * rule over a DOM fact; no decision model votes on it.
   */
  irreversible?: readonly string[];
  /** How many probes have already been run on this page. */
  probesRun?: number;
}

function leaderOf(prior: Readonly<Record<string, number>>): { id: string; mass: number } {
  let id = 'none';
  let mass = -1;
  for (const [candidate, value] of Object.entries(prior)) {
    if (value > mass) {
      id = candidate;
      mass = value;
    }
  }
  return { id, mass: Math.max(mass, 0) };
}

/** Renormalized belief over the candidates the caller would actually action. */
export function liveCandidates(
  prior: Readonly<Record<string, number>>,
  exclude: readonly string[] = [],
): Record<string, number> {
  const excluded = new Set(exclude);
  const kept: Record<string, number> = {};
  let total = 0;

  for (const [candidate, mass] of Object.entries(prior)) {
    if (candidate === 'none' || excluded.has(candidate) || mass <= 0) continue;
    kept[candidate] = mass;
    total += mass;
  }
  if (total <= 0) return {};

  for (const candidate of Object.keys(kept)) {
    kept[candidate] = (kept[candidate] ?? 0) / total;
  }
  return kept;
}

/**
 * Turns a belief plus three scalar judgements into the next machine action.
 *
 * Ordered by how much the answer is already settled: finished, then finishing,
 * then proven impossible, then uncertain. The uncertain branch is the one this
 * file exists for.
 */
export function decide(input: DecisionInput): Route {
  const { prior, signals, probes, budget, hasAlternative } = input;
  const irreversible = new Set(input.irreversible ?? []);

  if (signals.goalMet >= THRESHOLDS.goalMet) {
    return { kind: 'complete', reason: 'the page confirms the task was carried out' };
  }

  if (signals.deadEnd >= THRESHOLDS.deadEnd) {
    return hasAlternative
      ? {
          kind: 'backtrack',
          reason:
            'this page rules the route out explicitly - resuming from the best surviving ' +
            'alternative, which exists because the branch point was ranked rather than resolved',
        }
      : {
          kind: 'refuse',
          status: 'no_path',
          reason:
            'this page rules the route out and the frontier holds no untried alternative - ' +
            'stopping, having changed nothing',
        };
  }

  // Two views of the same belief. `atTarget` decides which one is in force, and
  // only the commit gate ever looks at the one containing irreversible controls.
  const everything = liveCandidates(prior, input.exclude ?? []);
  const navigable = liveCandidates(prior, [...(input.exclude ?? []), ...irreversible]);
  const onTarget = signals.atTarget >= THRESHOLDS.atTarget;
  const live = onTarget ? everything : navigable;

  if (Object.keys(live).length === 0) {
    return hasAlternative
      ? { kind: 'backtrack', reason: 'nothing on this page advances the task' }
      : {
          kind: 'refuse',
          status: 'no_path',
          reason: 'nothing on this page advances the task and there is nowhere left to resume from',
        };
  }

  const leader = leaderOf(live);

  // The point of no return. Reached only when the page says the action happens
  // here AND the belief about which control performs it has actually
  // concentrated. A high `atTarget` with a flat target distribution is not
  // permission to submit; it is a reason to probe.
  if (onTarget && leader.mass >= THRESHOLDS.commit) {
    return {
      kind: 'commit',
      reason:
        `this is the page the task is carried out on, and ${leader.id} holds ` +
        `${leader.mass.toFixed(2)} of the mass, at or above the ${THRESHOLDS.commit} commit threshold`,
      leader: leader.id,
      probability: leader.mass,
    };
  }

  if (!onTarget && leader.mass >= THRESHOLDS.navigate) {
    return {
      kind: 'navigate',
      elementId: leader.id,
      probability: leader.mass,
      reason:
        `${leader.id} holds ${leader.mass.toFixed(2)} of the mass, at or above the ` +
        `${THRESHOLDS.navigate} navigate threshold`,
    };
  }

  // --- flat, or flat-enough that an irreversible step is off the table ------
  const affordable = probes.filter((probe) => probe.cost <= budget);
  const selection = selectProbe(live, affordable, {
    minimumGain: 0.05,
    minimumGainFraction: 0.1,
    decisionThreshold: onTarget ? THRESHOLDS.commit : THRESHOLDS.navigate,
  });

  if (selection.chosen !== null) {
    return {
      kind: 'probe',
      probeId: selection.chosen.probe.id,
      cost: selection.chosen.probe.cost,
      selection,
      reason: selection.reason,
    };
  }

  if (hasAlternative) {
    return {
      kind: 'backtrack',
      reason:
        `no affordable probe earns its cost (${budget} budget unit(s) left) - resuming from ` +
        'the best surviving alternative instead of guessing',
    };
  }

  return {
    kind: 'refuse',
    status: (input.probesRun ?? 0) > 0 ? 'probes_exhausted' : 'refused',
    reason:
      `the distribution is flat (leader ${leader.id} at ${leader.mass.toFixed(2)}) and ` +
      `${selection.reason}. Stopping without acting, having changed nothing.`,
  };
}
