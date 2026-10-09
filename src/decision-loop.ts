/**
 * The decision loop shared by the FSI examples.
 *
 * An example supplies data: one bounded choice, optional yes/no questions asked
 * in the same request, read-only probes with authored partitions, a deterministic
 * gate, and a plan. This file does the deciding, so every example follows the same
 * three outcomes and none of them can route a decision to a person:
 *
 *   act      the distribution passes its tests and the gate passes. The plan runs
 *            reversible steps first, each verified by reading the record back.
 *   probe    the distribution is flat and an affordable probe is worth its cost.
 *            The observation goes back to Jev as evidence, and Jev judges again.
 *   refuse   the distribution is not confident, the gate refuses, or no affordable
 *            probe helps. Nothing is changed.
 *
 * The kernel's posterior is printed beside Jev's re-judgement so the two can be
 * compared. They are not the same number and the output says so.
 */

import { choice, noul, type Questions } from '@typesafe-ai/sdk';
import type { ExampleClient } from './client.ts';
import type { MockScript, ScriptedAnswer } from './mock-fetch.ts';
import { normalizedEntropy, partitionProbe, posterior, selectProbe } from './information-gain.ts';
import { runPlan, validatePlan, type PlanResult, type Step } from './compensate.ts';
import { bold, cyan, dim, green, red, yellow } from './ui.ts';

export const NONE = 'none_of_these';
export const ACT_LEADER = 0.7;
export const ACT_MARGIN = 0.25;
export const ACT_ENTROPY = 0.6;
export const MIN_PROBE_GAIN_FRACTION = 0.1;

/** Words the architecture contract bans from routes and outcomes. */
export const BANNED_ROUTE_WORDS = ['escalate', 'approval_required', 'ops_queue', 'review', 'handoff'] as const;

export type Log = (line: string) => void;
export type Tally = Readonly<Record<string, number>>;
export type Route = 'act' | 'refuse';
export type Outcome = PlanResult['outcome'] | 'refused';

export interface ProbeSpec<R> {
  id: string;
  cost: number;
  description: string;
  /** Reads the record without changing it. Returns a key of `buckets`. */
  read: (record: R) => string;
  /** The candidates each observation supports. Candidates in no bucket are unaffected. */
  buckets: Readonly<Record<string, readonly string[]>>;
}

export interface Expectation {
  outcome: Outcome;
  /** Whether the leader changed between the first judgement and the last. */
  flipped?: boolean;
}

export interface Decision<R> {
  id: string;
  title: string;
  /** The one choice question. Keys are the options that survived the gate, plus NONE. */
  instructions: string;
  options: Readonly<Record<string, string>>;
  /** Yes/no questions asked in the same request as the choice. */
  indicators?: Readonly<Record<string, string>>;
  record: R;
  /** The state Jev sees, derived from the record. Observations are added by the loop. */
  state: (record: R) => Record<string, unknown>;
  probes: readonly ProbeSpec<R>[];
  budget: number;
  /** Fixture answers as a function of the observations so far. Ignored by live Jev. */
  scripted: (observations: readonly string[]) => { distribution: Tally; indicators?: Tally };
  /** Deterministic precondition for the leader. Returns the reason to refuse, or null. */
  gate: (record: R, option: string, indicators: Tally) => string | null;
  plan: (option: string, record: R, indicators: Tally) => Step<R>[];
  expect: Expectation;
}

export interface ProbeRun {
  id: string;
  cost: number;
  observation: string;
}

export interface Result {
  id: string;
  title: string;
  route: Route;
  outcome: Outcome;
  reason: string;
  firstLeader: string;
  leader: string;
  probability: number;
  flipped: boolean;
  probes: ProbeRun[];
  indicators: Tally;
  steps: PlanResult['steps'];
  expect: Expectation;
}

interface Answer {
  distribution: Record<string, number>;
  indicators: Record<string, number>;
}

async function ask<R>(spec: Decision<R>, client: ExampleClient, observations: readonly string[]): Promise<Answer> {
  const questions: Questions = { route: choice(spec.instructions, { ...spec.options }) };
  const indicatorIds = Object.keys(spec.indicators ?? {});
  for (const id of indicatorIds) questions[id] = noul(spec.indicators?.[id] ?? id);

  const { answers } = await client.client.systemOne({
    state: { ...spec.state(spec.record), observations: [...observations] },
    questions,
  });

  const byId = answers as unknown as Record<string, unknown>;
  const route = byId['route'] as { probabilities: Record<string, number> };
  const indicators: Record<string, number> = {};
  for (const id of indicatorIds) {
    indicators[id] = (byId[id] as { noul: number }).noul;
  }
  return { distribution: route.probabilities, indicators };
}

function printTally(log: Log, distribution: Tally, leader: string, probability: number, margin: number, entropy: number): void {
  for (const [name, mass] of Object.entries(distribution).sort((a, b) => b[1] - a[1])) {
    const bar = '█'.repeat(Math.round(mass * 24)).padEnd(24, '·');
    log(`    ${name.padEnd(26)} ${bar} ${(mass * 100).toFixed(1).padStart(5)}%`);
  }
  log(dim(`    leader ${leader} ${(probability * 100).toFixed(1)}% · margin ${margin.toFixed(2)} · normalised entropy ${entropy.toFixed(2)}`));
}

function printSteps(log: Log, plan: PlanResult): void {
  for (const step of plan.steps) {
    const mark = step.verified ? green('ok    ') : red('failed');
    log(`    step ${step.id.padEnd(22)} ${mark} ${step.detail}`);
    if (step.compensated) log(yellow(`    undone ${step.id}`));
  }
  if (plan.outcome === 'rolled_back') log(red(`    ${plan.reason}`));
}

function summarise<R>(
  spec: Decision<R>,
  fields: Omit<Result, 'id' | 'title' | 'flipped' | 'expect'>,
): Result {
  return {
    id: spec.id,
    title: spec.title,
    ...fields,
    flipped: fields.leader !== fields.firstLeader,
    expect: spec.expect,
  };
}

/**
 * Runs one decision to an outcome. The caller supplies the client, so a fixture run
 * and a live run differ only in the client they pass.
 */
export async function decide<R>(spec: Decision<R>, client: ExampleClient, log: Log = console.log): Promise<Result> {
  const observations: string[] = [];
  const probes: ProbeRun[] = [];
  const spent = new Set<string>();
  let remaining = spec.budget;
  let firstLeader: string | undefined;

  log(bold(spec.title));
  log(dim(`    budget ${spec.budget} · ${spec.probes.length} probe(s) authored · ${Object.keys(spec.options).length} option(s) offered`));

  for (;;) {
    const answer = await ask(spec, client, observations);
    const ranked = Object.entries(answer.distribution).sort((a, b) => b[1] - a[1]);
    const leader = ranked[0]?.[0] ?? NONE;
    const probability = ranked[0]?.[1] ?? 0;
    const margin = probability - (ranked[1]?.[1] ?? 0);
    const entropy = normalizedEntropy(Object.values(answer.distribution));
    firstLeader ??= leader;

    printTally(log, answer.distribution, leader, probability, margin, entropy);
    if (Object.keys(answer.indicators).length > 0) {
      log(dim(`    ${Object.entries(answer.indicators).map(([id, p]) => `${id} ${(p * 100).toFixed(0)}%`).join(' · ')}`));
    }

    const base = { route: 'refuse' as Route, firstLeader, leader, probability, probes, indicators: answer.indicators, steps: [] as PlanResult['steps'] };
    const confident = leader !== NONE && probability >= ACT_LEADER && margin >= ACT_MARGIN && entropy <= ACT_ENTROPY;

    if (confident) {
      const problem = spec.gate(spec.record, leader, answer.indicators);
      if (problem !== null) {
        log(red(`  REFUSE  gate: ${problem}`));
        return summarise(spec, { ...base, outcome: 'refused', reason: `gate: ${problem}` });
      }
      const steps = spec.plan(leader, spec.record, answer.indicators);
      const problems = validatePlan(steps);
      if (problems.length > 0) {
        log(red(`  REFUSE  plan: ${problems.join('; ')}`));
        return summarise(spec, { ...base, outcome: 'refused', reason: `plan: ${problems.join('; ')}` });
      }
      log(green(`  ACT     ${leader}`));
      const plan = await runPlan(steps, spec.record);
      printSteps(log, plan);
      return summarise(spec, {
        ...base,
        route: 'act',
        outcome: plan.outcome,
        reason: plan.reason,
        steps: plan.steps,
      });
    }

    const unspent = spec.probes.filter((probe) => !spent.has(probe.id));
    const affordable = unspent.filter((probe) => probe.cost <= remaining);
    const selection = selectProbe(
      answer.distribution,
      affordable.map((probe) => partitionProbe(probe.id, probe.cost, probe.buckets, probe.description)),
      { minimumGainFraction: MIN_PROBE_GAIN_FRACTION, exclude: [...spent] },
    );

    const picked = selection.chosen;
    if (picked === null) {
      const cheapest = unspent.reduce((min, probe) => Math.min(min, probe.cost), Infinity);
      const reason = unspent.length > 0 && affordable.length === 0
        ? `no affordable probe left: ${remaining} of ${spec.budget} budget left, and the cheapest unspent probe costs ${cheapest}`
        : selection.reason;
      log(red(`  REFUSE  ${reason}. Nothing was changed.`));
      return summarise(spec, { ...base, outcome: 'refused', reason });
    }

    const chosen = spec.probes.find((probe) => probe.id === picked.probe.id);
    if (chosen === undefined) throw new Error(`${spec.id}: selected probe ${picked.probe.id} is not authored`);
    const observation = chosen.read(spec.record);
    if (!(observation in chosen.buckets)) {
      throw new Error(`${spec.id}: probe ${chosen.id} read "${observation}", which no bucket names`);
    }

    const predicted = Object.entries(posterior(answer.distribution, picked.probe, observation))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([id, p]) => `${id} ${(p * 100).toFixed(0)}%`)
      .join(', ');
    log(cyan(`  PROBE   ${chosen.id} (cost ${chosen.cost}): ${chosen.description}`));
    log(dim(`          observed ${observation} · kernel posterior ${predicted}`));

    observations.push(`${chosen.id}:${observation}`);
    probes.push({ id: chosen.id, cost: chosen.cost, observation });
    spent.add(chosen.id);
    remaining -= chosen.cost;
  }
}

/** A fixture client for one decision, so scripted answers follow the observations. */
export function scriptFor<R>(spec: Decision<R>): MockScript {
  return ({ state }) => {
    const observations = (state as { observations?: readonly string[] }).observations ?? [];
    const answer = spec.scripted(observations);
    const out: Record<string, ScriptedAnswer> = { route: { distribution: { ...answer.distribution } } };
    for (const id of Object.keys(spec.indicators ?? {})) {
      out[id] = { noul: answer.indicators?.[id] ?? 0 };
    }
    return out;
  };
}

/**
 * A field write that verifies by reading the record back. It undoes itself in
 * `compensate`. `healthy` models a dependency that can refuse the write: when it
 * returns false, verification fails and the plan rolls back.
 */
export function setField<R extends object>(options: {
  id: string;
  description: string;
  field: string;
  value: unknown;
  healthy?: (record: R) => boolean;
  unhealthyReason?: string;
}): Step<R> {
  let previous: unknown;
  const read = (record: R): unknown => (record as Record<string, unknown>)[options.field];
  const write = (record: R, value: unknown): void => {
    (record as Record<string, unknown>)[options.field] = value;
  };
  const expected = JSON.stringify(options.value);
  return {
    id: options.id,
    description: options.description,
    reversible: true,
    act: (record) => {
      previous = read(record);
      write(record, options.value);
    },
    verify: (record) => {
      if (options.healthy && !options.healthy(record)) {
        return { ok: false, detail: `${options.field} not written: ${options.unhealthyReason ?? 'the store did not confirm'}` };
      }
      const ok = JSON.stringify(read(record)) === expected;
      return { ok, detail: ok ? `${options.field} reads back as ${expected}` : `${options.field} does not read back` };
    },
    compensate: (record) => {
      write(record, previous);
    },
  };
}

/**
 * Runs a plan that a deterministic rule selected, with no model call. The
 * result has the same shape as a decided one so examples can print them together.
 */
export async function actOnRules<R>(options: {
  id: string;
  title: string;
  rule: string;
  steps: Step<R>[];
  record: R;
  expect: Expectation;
  log?: Log;
}): Promise<Result> {
  const log = options.log ?? console.log;
  log(bold(options.title));
  log(dim(`    rule  ${options.rule}`));
  log(dim('    resolved by a deterministic rule; no request was built'));
  const plan = await runPlan(options.steps, options.record);
  printSteps(log, plan);
  return {
    id: options.id,
    title: options.title,
    route: 'act',
    outcome: plan.outcome,
    reason: `rule: ${options.rule}`,
    firstLeader: 'rule',
    leader: options.rule,
    probability: 1,
    flipped: false,
    probes: [],
    indicators: {},
    steps: plan.steps,
    expect: options.expect,
  };
}

export function printSummary(results: readonly Result[], log: Log = console.log): void {
  log(bold('\nSummary'));
  for (const result of results) {
    const colour = result.outcome === 'completed' ? green : result.outcome === 'refused' ? red : yellow;
    const spend = result.probes.length > 0
      ? `${result.probes.length} probe(s), cost ${result.probes.reduce((sum, p) => sum + p.cost, 0)}`
      : 'no probe';
    const flip = result.flipped ? ' · probe changed the answer' : '';
    log(`  ${result.id.padEnd(24)} ${colour(result.outcome.padEnd(12))} ${result.leader.padEnd(28)} ${spend}${flip}`);
  }
}
