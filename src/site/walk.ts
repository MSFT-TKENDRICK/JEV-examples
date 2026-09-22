/**
 * The simulated driver, and the search loop both simulated examples run.
 *
 * Example 04 uses this so it runs with no browser and no API key. Example 06
 * runs *both* arms through it, which is what makes "same site, same loop, same
 * click mechanics, different decision model" a statement about the code rather
 * than a claim in a README.
 *
 * The loop is four moves, and only the last one is interesting:
 *
 *   arrive    describe the page as a compact element list, never raw HTML
 *   judge     one Jev request: a distribution over the elements, plus three
 *             scalar judgements
 *   resolve   while the distribution is too flat to act on, run the probe with
 *             the highest expected information gain per unit cost, update the
 *             posterior, re-judge the *decision* (not the model)
 *   act       navigate, backtrack to the best surviving alternative, commit
 *             through the act/verify/compensate runner, or refuse
 *
 * The frontier is what makes `backtrack` mean anything. Every navigation
 * expands the current node with every branch the distribution put mass on, so
 * when a page later proves the route dead, `frontier.best()` has somewhere to
 * resume from. That alternative is a piece of the distribution. An argmax
 * interface never produced it.
 */

import type { Assessment, Probe } from '../information-gain.ts';
import { partitionProbe, posterior } from '../information-gain.ts';
import type { FrontierStats } from '../frontier.ts';
import { createFrontier, pathProbability } from '../frontier.ts';
import type { Route, Signals, Status } from '../browser-policy.ts';
import { PROBE_BUDGET, decide, liveCandidates } from '../browser-policy.ts';
import type { PlanResult, Step } from '../compensate.ts';
import { runPlan } from '../compensate.ts';

import type { SitePage } from './graph.ts';
import { ENTRY, TASK, page } from './graph.ts';

/** Turns the site's authored peeks into probes the EIG kernel can rank. */
export function toProbes(site: SitePage): Probe[] {
  return (site.probes ?? []).map((probe) =>
    partitionProbe(probe.id, probe.cost, probe.buckets, probe.description),
  );
}

/**
 * Step 2 of the loop. Ordinary code, and where the token savings live: Jev sees
 * a short structured summary, never the DOM.
 */
export function describe(site: SitePage, history: readonly string[]) {
  return {
    task: TASK,
    url: site.file,
    visibleText: site.text,
    candidates: Object.fromEntries(
      site.elements.map((element) => [element.id, `${element.role}: ${element.label}`]),
    ),
    stepsTaken: history,
  };
}

/** What a decision model must supply per page. Jev and the control both fit. */
export interface Judge {
  label: string;
  detail: string;
  /**
   * How many partial paths the frontier may keep.
   *
   * Jev sets this above 1 because a distribution ranks every branch. The
   * control arm sets it to 1 because a single answer cannot rank anything else,
   * and that is the whole of its disadvantage here.
   */
  beamWidth: number;
  judge(
    site: SitePage,
    history: readonly string[],
  ): Promise<{ prior: Record<string, number>; signals: Signals }>;
}

export interface ProbeRun {
  page: string;
  probeId: string;
  cost: number;
  observation: string;
  before: Record<string, number>;
  after: Record<string, number>;
  ranked: readonly Assessment[];
  expectedInformationGain: number;
}

export interface BacktrackRun {
  from: string;
  to: string;
  via: readonly string[];
  /** Path probability of the alternative resumed from. */
  alternativeMass: number;
  reason: string;
}

export type WalkEvent =
  | { type: 'arrive'; site: SitePage; step: number; tokens: number }
  | { type: 'verified'; url: string; elements: number; matched: boolean; detail: string }
  | { type: 'judged'; prior: Record<string, number>; signals: Signals }
  | { type: 'probe'; run: ProbeRun }
  | { type: 'navigate'; elementId: string; label: string; probability: number; to: string }
  | { type: 'deadEnd'; site: SitePage; proof: string }
  | { type: 'backtrack'; run: BacktrackRun }
  | { type: 'commit'; elementId: string; label: string; probability: number; plan: PlanResult }
  | { type: 'refuse'; status: Status; reason: string }
  | { type: 'complete'; reason: string }
  | { type: 'route'; route: Route };

/**
 * A real browser, driven by the same loop.
 *
 * Example 05 supplies one of these. Everything the loop decides is unchanged;
 * only the actions become real. `describe()` exists so the run can check that
 * the page Chrome actually rendered carries the elements the graph says it
 * does - which is what stops the live example quietly falling back to the
 * fixture.
 */
export interface WalkDriver {
  start(entryFile: string): Promise<void>;
  describe(): Promise<{ url: string; text: string; elements: readonly { id: string; label: string }[] }>;
  peek(probeId: string): Promise<string>;
  click(elementId: string, label: string): Promise<void>;
  fill(elementId: string, value: string): Promise<void>;
  readValue(elementId: string): Promise<string>;
  /** Backtracking in a browser is replaying the path, not teleporting to a URL. */
  replay(steps: readonly { elementId: string; label: string }[], entryFile: string): Promise<void>;
  caption(text: string): Promise<void>;
}

export interface WalkOptions {
  judge: Judge;
  maxSteps?: number;
  /** Probe-cost units for the whole run. */
  budget?: number;
  /**
   * Overrides what a peek returns, per probe id.
   *
   * Used by the refusal fixture to model an account whose pages do not render
   * the metadata the peeks read. The probes still run and still cost their
   * budget; they simply come back `unknown`, and `posterior()` falls back to
   * the prior because no candidate predicts that observation.
   */
  observations?: Readonly<Record<string, string>>;
  /** Supply to run the same loop against a real browser. */
  driver?: WalkDriver;
  onEvent?: (event: WalkEvent) => void;
}

export interface WalkResult {
  status: Status;
  reason: string;
  visited: string[];
  history: string[];
  probes: ProbeRun[];
  backtracks: BacktrackRun[];
  budgetSpent: number;
  budgetLeft: number;
  steps: number;
  /** One Jev request per page arrival. */
  judgeCalls: number;
  frontier: FrontierStats;
  plan?: PlanResult;
  finalPage: string;
}

/** Mutable state the re-issue form writes into. Stands in for the site's backend. */
interface ReissueContext {
  period: string | null;
  delivery: string | null;
  reference: string | null;
}

/**
 * The plan behind the one irreversible step on the happy path.
 *
 * Two reversible, verified steps, then the submit. `validatePlan` inside
 * `runPlan` rejects any ordering where the irreversible step is not last, so
 * the guarantee is enforced rather than described.
 *
 * With a driver the reversible steps type into the real form and verify by
 * reading the value back out of the DOM. Without one they write to in-process
 * state. The ordering guarantee is the same either way.
 */
export function reissuePlan(driver?: WalkDriver): readonly Step<ReissueContext>[] {
  const write = async (context: ReissueContext, field: 'period' | 'delivery', value: string) => {
    context[field] = value;
    if (driver !== undefined) await driver.fill(field === 'period' ? 'e1' : 'e2', value);
  };
  const read = async (context: ReissueContext, field: 'period' | 'delivery') =>
    driver === undefined
      ? (context[field] ?? '')
      : await driver.readValue(field === 'period' ? 'e1' : 'e2');
  const clear = async (context: ReissueContext, field: 'period' | 'delivery') => {
    context[field] = null;
    if (driver !== undefined) await driver.fill(field === 'period' ? 'e1' : 'e2', '');
  };

  return [
    {
      id: 'set-period',
      description: 'set the invoice period to September 2025',
      reversible: true,
      act: (context) => write(context, 'period', '2025-09'),
      verify: async (context) => {
        const value = await read(context, 'period');
        return value === '2025-09'
          ? { ok: true, detail: 'period reads back as 2025-09' }
          : { ok: false, detail: `period reads back as "${value}"` };
      },
      compensate: (context) => clear(context, 'period'),
    },
    {
      id: 'set-delivery',
      description: 'set the delivery address to the account owner',
      reversible: true,
      act: (context) => write(context, 'delivery', 'owner@meridian.example'),
      verify: async (context) => {
        const value = await read(context, 'delivery');
        return value === 'owner@meridian.example'
          ? { ok: true, detail: 'delivery address reads back as the account owner' }
          : { ok: false, detail: `delivery reads back as "${value}"` };
      },
      compensate: (context) => clear(context, 'delivery'),
    },
    {
      id: 'submit',
      description: 'submit the re-issue request to the billing provider',
      reversible: false,
      // Preflight runs for every step before any of them acts, so it can only
      // check what is already true. "Is this request not already submitted?" is
      // such a precondition; "is the form filled in?" is not, and lives in the
      // act guard below instead.
      preflight: (context) =>
        context.reference === null
          ? { ok: true, detail: 'no re-issue request has been submitted for this charge' }
          : { ok: false, detail: `already submitted as ${context.reference}` },
      act: async (context) => {
        if (context.period === null || context.delivery === null) {
          throw new Error('the form is not filled in');
        }
        context.reference = 'REQ-88213';
        if (driver !== undefined) {
          await driver.caption('submit - this one cannot be undone');
          await driver.click('e3', 'Submit re-issue request');
        }
      },
      verify: (context) =>
        context.reference === null
          ? { ok: false, detail: 'no reference returned' }
          : { ok: true, detail: `provider returned ${context.reference}` },
    },
  ];
}

export async function walk(options: WalkOptions): Promise<WalkResult> {
  const { judge, onEvent = () => {} } = options;
  const driver = options.driver;
  const maxSteps = options.maxSteps ?? 12;
  const startingBudget = options.budget ?? PROBE_BUDGET;
  let budget = startingBudget;

  await driver?.start(page(ENTRY).file);

  const frontier = createFrontier({
    beamWidth: judge.beamWidth,
    rootPage: ENTRY,
    rootLabel: 'account overview',
  });

  let current = frontier.root();
  const visited = new Set<string>();
  const history: string[] = [];
  const probes: ProbeRun[] = [];
  const backtracks: BacktrackRun[] = [];
  const context: ReissueContext = { period: null, delivery: null, reference: null };

  let status: Status = 'running';
  let reason = '';
  let plan: PlanResult | undefined;
  let steps = 0;
  let judgeCalls = 0;

  for (let step = 0; step < maxSteps && status === 'running'; step++) {
    steps = step + 1;
    const site = page(current.page);
    visited.add(site.id);

    const state = describe(site, history);
    onEvent({
      type: 'arrive',
      site,
      step: steps,
      tokens: Math.ceil(JSON.stringify(state).length / 4),
    });

    if (driver !== undefined) {
      // The graph says what should be on screen. Chrome says what is. If they
      // disagree the run is not exercising the site it claims to.
      const dom = await driver.describe();
      const expected = site.elements.map((element) => `${element.id}:${element.label}`).join(' | ');
      const actual = dom.elements.map((element) => `${element.id}:${element.label}`).join(' | ');
      const matched = dom.url === site.file && expected === actual;
      onEvent({
        type: 'verified',
        url: dom.url,
        elements: dom.elements.length,
        matched,
        detail: matched ? `${dom.elements.length} elements match the graph` : `DOM: ${actual}`,
      });
      if (!matched) {
        throw new Error(
          `The rendered page ${dom.url} does not match graph page ${site.id}. ` +
            'Re-run `node src/site/render.ts`.',
        );
      }
      await driver.caption(`judging ${site.title}`);
    }

    const judged = await judge.judge(site, history);
    judgeCalls++;
    onEvent({ type: 'judged', prior: judged.prior, signals: judged.signals });

    // Destinations already seen are not alternatives. Dropping them here rather
    // than inside `decide` keeps the policy free of walk bookkeeping.
    const seen = site.elements
      .filter((element) => element.to !== undefined && visited.has(element.to))
      .map((element) => element.id);
    const irreversible = site.elements
      .filter((element) => element.irreversible === true)
      .map((element) => element.id);

    let prior = liveCandidates(judged.prior, seen);
    const available = toProbes(site);
    const ran: string[] = [];

    // --- resolve: probe until the decision is no longer a probe -------------
    let route: Route = { kind: 'refuse', status: 'refused', reason: 'no decision taken' };
    for (;;) {
      const taken = decide({
        prior,
        signals: judged.signals,
        probes: available.filter((probe) => !ran.includes(probe.id)),
        budget,
        hasAlternative: frontier.ranked().some((node) => node.id !== current.id),
        irreversible,
        probesRun: ran.length,
      });

      if (taken.kind !== 'probe') {
        route = taken;
        break;
      }
      route = taken;

      const authored = (site.probes ?? []).find((candidate) => candidate.id === taken.probeId);
      const kernel = available.find((candidate) => candidate.id === taken.probeId);
      if (authored === undefined || kernel === undefined) {
        throw new Error(`Probe ${taken.probeId} selected but not found on ${site.id}`);
      }

      const observation =
        options.observations?.[authored.id] ??
        (driver === undefined ? authored.observation : await driver.peek(authored.id));
      const before = prior;
      const after = posterior(before, kernel, observation);

      budget -= taken.cost;
      ran.push(taken.probeId);
      prior = after;

      const run: ProbeRun = {
        page: site.id,
        probeId: taken.probeId,
        cost: taken.cost,
        observation,
        before,
        after,
        ranked: taken.selection.ranked,
        expectedInformationGain: taken.selection.chosen?.expectedInformationGain ?? 0,
      };
      probes.push(run);
      onEvent({ type: 'probe', run });
    }

    onEvent({ type: 'route', route });

    switch (route.kind) {
      case 'complete': {
        status = 'goal_reached';
        reason = route.reason;
        onEvent({ type: 'complete', reason });
        break;
      }

      case 'backtrack': {
        if (site.deadEnd !== undefined) {
          onEvent({ type: 'deadEnd', site, proof: site.deadEnd });
        }
        frontier.markDead(current.id, route.reason);
        const next = frontier.best();
        if (next === null) {
          status = 'no_path';
          reason = 'the frontier is empty: every path the distribution ranked has been ruled out';
          onEvent({ type: 'refuse', status, reason });
          break;
        }
        const run: BacktrackRun = {
          from: site.id,
          to: next.page,
          via: frontier.pathTo(next.id).map((entry) => entry.label),
          alternativeMass: pathProbability(next),
          reason: route.reason,
        };
        backtracks.push(run);
        onEvent({ type: 'backtrack', run });
        if (driver !== undefined) {
          await driver.caption(`dead end - resuming from "${next.label}"`);
          await driver.replay(
            frontier.pathTo(next.id).map((entry) => ({
              elementId: entry.elementId,
              label: entry.label,
            })),
            page(ENTRY).file,
          );
        }
        history.push(`backtrack to "${next.label}"`);
        current = next;
        break;
      }

      case 'navigate': {
        const element = site.elements.find((candidate) => candidate.id === route.elementId);
        if (element?.to === undefined) {
          status = 'no_path';
          reason = `the leading candidate ${route.elementId} does not navigate anywhere`;
          onEvent({ type: 'refuse', status, reason });
          break;
        }

        const children = branchesFrom(site, prior, visited, irreversible);
        const created = frontier.expand(current.id, children);
        const next = created.find((node) => node.elementId === route.elementId);
        if (next === undefined) {
          status = 'no_path';
          reason = `${route.elementId} was not retained on the frontier`;
          onEvent({ type: 'refuse', status, reason });
          break;
        }

        onEvent({
          type: 'navigate',
          elementId: element.id,
          label: element.label,
          probability: route.probability,
          to: element.to,
        });
        if (driver !== undefined) {
          await driver.caption(`click "${element.label}"`);
          await driver.click(element.id, element.label);
        }
        history.push(`click "${element.label}"`);
        current = next;
        break;
      }

      case 'commit': {
        const element = site.elements.find((candidate) => candidate.id === route.leader);
        if (element === undefined || element.to === undefined) {
          status = 'refused';
          reason = 'the committing control does not lead anywhere';
          onEvent({ type: 'refuse', status, reason });
          break;
        }

        plan = await runPlan(reissuePlan(driver), context);
        onEvent({
          type: 'commit',
          elementId: element.id,
          label: element.label,
          probability: route.probability,
          plan,
        });

        if (plan.outcome !== 'completed') {
          status = 'refused';
          reason = `the plan did not complete: ${plan.reason}`;
          onEvent({ type: 'refuse', status, reason });
          break;
        }

        const created = frontier.expand(current.id, [
          {
            elementId: element.id,
            label: element.label,
            page: element.to,
            probability: route.probability,
          },
        ]);
        const next = created[0];
        if (next === undefined) {
          status = 'refused';
          reason = 'the committed step produced no successor';
          onEvent({ type: 'refuse', status, reason });
          break;
        }
        history.push(`submit "${element.label}"`);
        current = next;
        break;
      }

      case 'refuse': {
        status = route.status;
        reason = route.reason;
        onEvent({ type: 'refuse', status, reason });
        break;
      }
    }

    if (status === 'running' && step === maxSteps - 1) {
      status = 'max_steps';
      reason = `stopped after ${maxSteps} steps`;
    }
  }

  return {
    status,
    reason,
    visited: [...visited],
    history,
    probes,
    backtracks,
    budgetSpent: startingBudget - budget,
    budgetLeft: budget,
    steps,
    judgeCalls,
    frontier: frontier.stats(),
    ...(plan === undefined ? {} : { plan }),
    finalPage: current.page,
  };
}

/**
 * The branches worth putting on the frontier from this page.
 *
 * Deduplicated by destination, because two links to the same page are one
 * alternative and should not occupy two beam slots. Irreversible controls are
 * never alternatives: they are commits, and commits are gated elsewhere.
 */
function branchesFrom(
  site: SitePage,
  prior: Readonly<Record<string, number>>,
  visited: ReadonlySet<string>,
  irreversible: readonly string[],
) {
  const byDestination = new Map<string, { elementId: string; label: string; probability: number }>();

  for (const element of site.elements) {
    if (element.to === undefined || visited.has(element.to)) continue;
    if (irreversible.includes(element.id)) continue;

    const mass = prior[element.id] ?? 0;
    if (mass <= 0) continue;

    const existing = byDestination.get(element.to);
    if (existing === undefined) {
      byDestination.set(element.to, {
        elementId: element.id,
        label: element.label,
        probability: mass,
      });
    } else {
      // Same destination, so the masses are alternatives for the same move.
      const heavier = mass > existing.probability ? element : null;
      byDestination.set(element.to, {
        elementId: heavier?.id ?? existing.elementId,
        label: heavier?.label ?? existing.label,
        probability: existing.probability + mass,
      });
    }
  }

  return [...byDestination.entries()].map(([destination, entry]) => ({
    elementId: entry.elementId,
    label: entry.label,
    page: destination,
    probability: entry.probability,
  }));
}
