/**
 * Checks for src/information-gain.ts.
 *
 * The probe-selection math decides what every redesigned example does next, so
 * it is verified against hand-computed values rather than trusted.
 */

import {
  assess,
  eigIsDegenerate,
  entropy,
  normalizedEntropy,
  partitionProbe,
  posterior,
  selectProbe,
} from './information-gain.ts';

let failures = 0;
let total = 0;

function check(label: string, condition: boolean, detail?: string): void {
  total++;
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    failures++;
    console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function near(actual: number, expected: number, tolerance = 1e-4): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

const LN2 = Math.log(2);

// --- entropy -----------------------------------------------------------------

check('uniform over 2 has entropy ln 2', near(entropy([0.5, 0.5]), LN2));
check('uniform over 4 has entropy ln 4', near(entropy([0.25, 0.25, 0.25, 0.25]), Math.log(4)));
check('a point mass has zero entropy', near(entropy([1, 0, 0]), 0));
check('entropy renormalizes unnormalized input', near(entropy([5, 5]), LN2));
check('entropy of empty input is zero', near(entropy([]), 0));
check('negative mass is ignored rather than producing NaN', Number.isFinite(entropy([0.5, 0.5, -1])));

check('normalized entropy of uniform is 1', near(normalizedEntropy([0.25, 0.25, 0.25, 0.25]), 1));
check('normalized entropy of a point mass is 0', near(normalizedEntropy([1, 0, 0, 0]), 0));

// --- the degenerate case, which is the whole argument ------------------------

const pointEstimate = { a: 1, b: 0, c: 0 };
const perfect = partitionProbe('perfect', 1, { yes: ['a'], no: ['b', 'c'] });

check('a point estimate is detected as degenerate', eigIsDegenerate(pointEstimate));
check(
  'a perfectly discriminating probe gains nothing against a point estimate',
  near(assess(pointEstimate, perfect).expectedInformationGain, 0),
  'this is the claim the control arm rests on',
);
check(
  'probe selection refuses on a degenerate prior',
  selectProbe(pointEstimate, [perfect]).degenerate === true &&
    selectProbe(pointEstimate, [perfect]).chosen === null,
);
check('a spread prior is not degenerate', !eigIsDegenerate({ a: 0.5, b: 0.5 }));

// --- gain on an informative probe --------------------------------------------

const coinFlip = { x: 0.5, y: 0.5 };
const splitsThem = partitionProbe('splits', 1, { left: ['x'], right: ['y'] });

check(
  'a perfect split of a coin flip removes all entropy',
  near(assess(coinFlip, splitsThem).expectedInformationGain, LN2),
);
check(
  'expected posterior entropy of a perfect split is zero',
  near(assess(coinFlip, splitsThem).expectedPosteriorEntropy, 0),
);

const uninformative = partitionProbe('flat', 1, { same: ['x', 'y'], never: [] });
check(
  'a probe that cannot separate anything gains nothing',
  near(assess(coinFlip, uninformative).expectedInformationGain, 0),
);

// --- posterior ---------------------------------------------------------------

const after = posterior(coinFlip, splitsThem, 'left');
check('observing a discriminating outcome collapses the posterior', near(after.x ?? 0, 1));
check('the ruled-out candidate drops to zero', near(after.y ?? 0, 0));

const impossible = posterior(coinFlip, splitsThem, 'not-an-observation');
check(
  'an unpredicted observation falls back to the prior instead of dividing by zero',
  near(impossible.x ?? 0, 0.5) && near(impossible.y ?? 0, 0.5),
);

// --- ranking, against hand-computed values -----------------------------------

const threeWay = { x: 0.45, y: 0.45, z: 0.1 };
const splitHeavyweights = partitionProbe('heavy', 1, { hit: ['x'], miss: ['y', 'z'] });
const isolateLongShot = partitionProbe('long', 1, { hit: ['z'], miss: ['x', 'y'] });

const heavy = assess(threeWay, splitHeavyweights);
const long = assess(threeWay, isolateLongShot);

check('prior entropy matches the hand calculation', near(heavy.priorEntropy, 0.9489, 1e-3));
check('splitting the two heavyweights gains ~0.688 nats', near(heavy.expectedInformationGain, 0.688, 1e-3));
check('isolating the long shot gains ~0.325 nats', near(long.expectedInformationGain, 0.325, 1e-3));
check(
  'the probe that separates the contenders is preferred',
  selectProbe(threeWay, [isolateLongShot, splitHeavyweights]).chosen?.probe.id === 'heavy',
  'order of the input array must not matter',
);

check(
  'gain is never negative',
  [heavy, long, assess(coinFlip, uninformative)].every((a) => a.expectedInformationGain >= 0),
);

// --- cost --------------------------------------------------------------------

const expensiveButPerfect = partitionProbe('expensive', 100, { hit: ['x'], miss: ['y', 'z'] });
const cheapButWeak = partitionProbe('cheap', 1, { hit: ['z'], miss: ['x', 'y'] });

check(
  'cost efficiency prefers the cheap weak probe over the expensive perfect one',
  selectProbe(threeWay, [expensiveButPerfect, cheapButWeak]).chosen?.probe.id === 'cheap',
);
check(
  'raw gain prefers the perfect probe regardless of cost',
  selectProbe(threeWay, [expensiveButPerfect, cheapButWeak], { byCostEfficiency: false }).chosen
    ?.probe.id === 'expensive',
);

// --- stopping ----------------------------------------------------------------

const nearlyCertain = { x: 0.97, y: 0.02, z: 0.01 };

// Worth stating, because it is counterintuitive: a probe against a 0.97 leader
// still carries real gain (~0.135 of ~0.154 nats), because the 3% branch would
// genuinely change the answer. Stopping here is a budget decision, not a
// mathematical one, so it takes an explicit threshold rather than falling out
// of the nats floor.
const keepsProbing = selectProbe(nearlyCertain, [splitHeavyweights, isolateLongShot]);
check(
  'a peaked prior still shows gain when the probe could flip the answer',
  keepsProbing.chosen !== null,
);
check(
  'that gain is most of the remaining entropy',
  near((keepsProbing.chosen?.expectedInformationGain ?? 0) / (keepsProbing.chosen?.priorEntropy ?? 1), 0.875, 0.05),
);

const confident = selectProbe(nearlyCertain, [splitHeavyweights, isolateLongShot], {
  decisionThreshold: 0.9,
});
check('a decision threshold stops probing and acts', confident.chosen === null && !confident.degenerate);
check('stopping on confidence says so', confident.reason.includes('decision threshold'));

// A probe is only uninformative relative to a particular prior: this one is
// worthless against {x,y} but does carry gain against {x,y,z}, because it can
// still rule z in or out.
const noGain = selectProbe(coinFlip, [uninformative]);
check('a probe below the nats floor stops', noGain.chosen === null);
check('stopping on gain explains itself in terms of the floor', noGain.reason.includes('floor'));
check(
  'the same probe is informative against a prior it can actually split',
  selectProbe(threeWay, [uninformative]).chosen !== null,
);

check(
  'a fractional floor is scale-independent where an absolute one is not',
  selectProbe(nearlyCertain, [splitHeavyweights], { minimumGainFraction: 0.95 }).chosen === null &&
    selectProbe(threeWay, [splitHeavyweights], { minimumGainFraction: 0.5 }).chosen !== null,
);

check(
  'already-run probes are excluded',
  selectProbe(threeWay, [splitHeavyweights, isolateLongShot], { exclude: ['heavy'] }).chosen?.probe
    .id === 'long',
);
check(
  'exhausting the probe set returns no choice',
  selectProbe(threeWay, [splitHeavyweights], { exclude: ['heavy'] }).chosen === null,
);

// --- robustness --------------------------------------------------------------

const unlisted = partitionProbe('partial', 1, { hit: ['x'] });
check(
  'a candidate missing from every bucket stays alive rather than being zeroed',
  (posterior(threeWay, unlisted, 'hit').y ?? 0) > 0,
  'forgetting to list a candidate should weaken the probe, not eliminate the candidate',
);

console.log(failures === 0 ? `\n${total}/${total} checks passed.` : `\n${failures} of ${total} check(s) failed.`);
if (failures > 0) process.exitCode = 1;
