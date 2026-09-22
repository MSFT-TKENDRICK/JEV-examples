/**
 * Checks for the parts of the evaluation harness that do arithmetic on the
 * recorded trail, rather than merely printing it.
 *
 * `probeEconomy` is the reason this file exists. It will not see real input
 * until the examples that author probe catalogs land, and a metric that is
 * wrong on arrival is worse than one that is missing: it would be believed.
 * So it is exercised here against hand-built trails whose answers are obvious
 * by inspection.
 */

import { createLedger, metricsFor, stateReference } from '../../../src/ledger.ts';
import type { ConsideredProbe, DecisionRecord, ProbeRecord } from '../../../src/ledger.ts';
import { probeEconomy, resolution } from './sweep.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

/**
 * These are ratios of ratios, so exact equality is the wrong test: 0.6 / 0.2
 * is 2.9999999999999996 in binary floating point. Comparing with a tolerance
 * asserts the arithmetic, not the representation.
 */
const close = (actual: number | null, expected: number): boolean =>
  actual !== null && Math.abs(actual - expected) < 1e-9;

const OPTIONS = ['x', 'y'] as const;

function probe(
  costUnits: number,
  expectedInformationGain: number,
  considered?: readonly ConsideredProbe[],
  probeId = 'chosen',
): ProbeRecord {
  return {
    probeId,
    expectedInformationGain,
    priorEntropy: 0.69,
    observation: 'seen',
    posteriorEntropy: 0.69 - expectedInformationGain,
    costUnits,
    ...(considered ? { considered } : {}),
  };
}

/** A scoreable record carrying exactly the probe trail under test. */
function recordWith(probes: readonly ProbeRecord[]): DecisionRecord {
  const ledger = createLedger({ component: 'sweep-check', mode: 'SCRIPTED_MOCK' });
  return ledger.record({
    state: stateReference({ case: 1 }),
    candidates: { source: 's', version: 'v', optionIds: [...OPTIONS], readAt: 'now' },
    policy: { policyVersion: 'p', thresholds: {}, route: 'act', reason: 'r' },
    metrics: metricsFor({ x: 0.8, y: 0.2 }, 'x', OPTIONS),
    recommendation: { question: 'q', choice: 'x' },
    probes: [...probes],
    executed: { action: 'x' },
    latencyMs: 1,
  });
}

// 1. A step with no recorded alternatives is unmeasured, never a silent pass.
{
  const economy = probeEconomy([recordWith([probe(5, 0.4)])]);
  check('a probe with no `considered` set is unmeasured', economy.unmeasured === 1);
  check('and is not counted as measurable', economy.measurable === 0);
  check('and produces no disagreement', economy.disagreements === 0);
  check(
    'and reports no multipliers rather than defaulting to 1',
    economy.meanCostMultiplier === null && economy.meanGainMultiplier === null,
  );
}

// 2. A single available probe is not a choice either.
{
  const only: ConsideredProbe[] = [
    { probeId: 'chosen', expectedInformationGain: 0.4, costUnits: 5 },
  ];
  const economy = probeEconomy([recordWith([probe(5, 0.4, only)])]);
  check('a one-option set is unmeasured, because no choice existed', economy.unmeasured === 1);
}

// 3. When the cheapest probe is the one chosen, there is nothing to trade off.
{
  const options: ConsideredProbe[] = [
    { probeId: 'chosen', expectedInformationGain: 0.4, costUnits: 2 },
    { probeId: 'other', expectedInformationGain: 0.5, costUnits: 9 },
  ];
  const economy = probeEconomy([recordWith([probe(2, 0.4, options)])]);
  check('agreeing with cheapest-first is measurable', economy.measurable === 1);
  check('and records no disagreement', economy.disagreements === 0);
  check('and claims no multiplier it cannot support', economy.meanCostMultiplier === null);
}

// 4. The real case: EIG paid more for more. Both multipliers must be exact.
{
  const options: ConsideredProbe[] = [
    { probeId: 'chosen', expectedInformationGain: 0.6, costUnits: 4 },
    { probeId: 'cheap', expectedInformationGain: 0.2, costUnits: 2 },
  ];
  const economy = probeEconomy([recordWith([probe(4, 0.6, options)])]);
  check('a differing choice is a disagreement', economy.disagreements === 1);
  check('cost multiplier is chosen/cheapest', close(economy.meanCostMultiplier, 2), `${economy.meanCostMultiplier}`);
  check('gain multiplier is chosen/cheapest', close(economy.meanGainMultiplier, 3), `${economy.meanGainMultiplier}`);
  check('paying 2x for 3x is not a ranking violation', economy.rankingViolations === 0);
}

// 5. BLOCKING: an unflattering result must survive the arithmetic.
// 3x the cost for 1.5x the information is a loss, and the harness has to be
// able to say so. If this ever silently passes as a win, the column is noise.
{
  const options: ConsideredProbe[] = [
    { probeId: 'chosen', expectedInformationGain: 0.3, costUnits: 6 },
    { probeId: 'cheap', expectedInformationGain: 0.2, costUnits: 2 },
  ];
  const economy = probeEconomy([recordWith([probe(6, 0.3, options)])]);
  check('an overpaying choice still reports its multipliers', close(economy.meanCostMultiplier, 3));
  check('gain multiplier is reported honestly', close(economy.meanGainMultiplier, 1.5));
  check(
    'cost above gain is detected as a ranking violation',
    economy.rankingViolations === 1,
    'cheapest had better gain-per-cost',
  );
}

// 6. Multipliers average across steps, and unmeasured steps do not dilute them.
{
  const paidDouble: ConsideredProbe[] = [
    { probeId: 'chosen', expectedInformationGain: 0.4, costUnits: 4 },
    { probeId: 'cheap', expectedInformationGain: 0.2, costUnits: 2 },
  ];
  const paidQuadruple: ConsideredProbe[] = [
    { probeId: 'chosen', expectedInformationGain: 0.8, costUnits: 8 },
    { probeId: 'cheap', expectedInformationGain: 0.2, costUnits: 2 },
  ];
  const economy = probeEconomy([
    recordWith([probe(4, 0.4, paidDouble), probe(8, 0.8, paidQuadruple), probe(1, 0.1)]),
  ]);
  check('every probe in a trail is a step', economy.steps === 3);
  check('the bare probe is unmeasured', economy.unmeasured === 1);
  check('both real choices disagreed', economy.disagreements === 2);
  check(
    'cost multiplier is the mean of 2x and 4x',
    close(economy.meanCostMultiplier, 3),
    `${economy.meanCostMultiplier}`,
  );
}

// 7. A zero-cost cheapest probe must not produce Infinity in a report.
{
  const options: ConsideredProbe[] = [
    { probeId: 'chosen', expectedInformationGain: 0.4, costUnits: 4 },
    { probeId: 'free', expectedInformationGain: 0.1, costUnits: 0 },
  ];
  const economy = probeEconomy([recordWith([probe(4, 0.4, options)])]);
  check('a free alternative is still a disagreement', economy.disagreements === 1);
  check(
    'but yields no cost multiplier rather than Infinity',
    economy.meanCostMultiplier === null,
    `${economy.meanCostMultiplier}`,
  );
}

// 8. Records without a usable distribution are out of scope entirely.
{
  const ledger = createLedger({ component: 'sweep-check', mode: 'SCRIPTED_MOCK' });
  const unscoreable = ledger.record({
    state: stateReference({ case: 2 }),
    candidates: { source: 's', version: 'v', optionIds: [...OPTIONS], readAt: 'now' },
    policy: { policyVersion: 'p', thresholds: {}, route: 'refused', reason: 'r' },
    probes: [probe(3, 0.2)],
    executed: { action: 'none' },
    latencyMs: 1,
  });
  check('an unscoreable record contributes no probe steps', probeEconomy([unscoreable]).steps === 0);
}

// 9. `resolution` must read execution outcomes verbatim from compensate.ts.
{
  const ledger = createLedger({ component: 'sweep-check', mode: 'SCRIPTED_MOCK' });
  const base = {
    state: stateReference({ case: 3 }),
    candidates: { source: 's', version: 'v', optionIds: [...OPTIONS], readAt: 'now' },
    policy: { policyVersion: 'p', thresholds: {}, route: 'act', reason: 'r' },
    metrics: metricsFor({ x: 0.8, y: 0.2 }, 'x', OPTIONS),
    recommendation: { question: 'q', choice: 'x' },
    executed: { action: 'x' },
    latencyMs: 1,
  };
  const records = [
    ledger.record({ ...base, probes: [probe(2, 0.3)], execution: { outcome: 'completed', reason: 'ok', stepsAttempted: 1, stepsVerified: 1 } }),
    ledger.record({ ...base, probes: [probe(2, 0.3)], execution: { outcome: 'refused', reason: 'budget', stepsAttempted: 0, stepsVerified: 0 } }),
    ledger.record({ ...base, probes: [], execution: { outcome: 'completed', reason: 'ok', stepsAttempted: 1, stepsVerified: 1 } }),
    ledger.record({ ...base, probes: [probe(2, 0.3)], execution: { outcome: 'inconsistent', reason: 'bad', stepsAttempted: 2, stepsVerified: 1 } }),
  ];
  const summary = resolution(records);
  check('acting with no probe is counted separately', summary.actedImmediately === 1);
  check('probing then completing is resolved by probing', summary.resolvedByProbing === 1);
  check('probing then refusing is counted as refused', summary.refusedAfterProbing === 1);
  check('inconsistent is surfaced, not folded into refused', summary.inconsistent === 1);
  check('probe costs sum across records', summary.probeCost === 6, `${summary.probeCost}`);
}

console.log(
  failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`,
);
if (failures > 0) process.exit(1);
