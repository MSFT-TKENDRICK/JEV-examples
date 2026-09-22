/**
 * Checks for the scripting surface of src/mock-fetch.ts.
 *
 * Every example's fixtures are written against this contract, so the behaviour
 * that fixture authors depend on is pinned here rather than discovered when a
 * scenario quietly stops expressing what it claims to.
 */

import { choice } from '@typesafe-ai/sdk';
import { mockFetch, type MockScript } from './mock-fetch.ts';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    failures++;
    console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

const options = {
  alpha: 'first',
  bravo: 'second',
  charlie: 'third',
  delta: 'fourth',
  echo: 'fifth',
} as const;

async function ask(script: MockScript) {
  const response = await mockFetch(script)('https://api.example/v1/systemone', {
    method: 'POST',
    body: JSON.stringify({
      state: {},
      model: 'jev-1',
      questions: { pick: choice('which?', options) },
    }),
  });
  const body = (await response.json()) as {
    answers: { pick: { choice: string; probabilities: Record<string, number> } };
  };
  return body.answers.pick;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

// The emitted masses are exact to 4 decimal places, but adding them back up in
// floating point drifts by ~1e-16. That is an artifact of the summation, not of
// the wire format, so the invariant is stated with a tolerance.
function sumsToOne(values: number[]): boolean {
  return Math.abs(sum(values) - 1) < 1e-9;
}

async function main(): Promise<void> {
  // --- explicit distributions ------------------------------------------------

  const torn = await ask(() => ({
    pick: { distribution: { alpha: 0.42, echo: 0.38, charlie: 0.2 } },
  }));

  check('an explicit distribution is returned as written', torn.probabilities.alpha === 0.42);
  check('the choice is the argmax of that distribution', torn.choice === 'alpha');
  check(
    'mass on a non-adjacent option survives',
    torn.probabilities.echo === 0.38,
    'this is the case peaked() cannot express, and the reason the option exists',
  );
  check(
    'the runner-up is the intended one rather than an index neighbour',
    (torn.probabilities.echo ?? 0) > (torn.probabilities.bravo ?? 0),
  );
  check('options omitted from the script get zero mass', torn.probabilities.bravo === 0);
  check('probabilities sum to exactly 1', sumsToOne(Object.values(torn.probabilities)));

  // --- normalization ---------------------------------------------------------

  const unnormalized = await ask(() => ({ pick: { distribution: { alpha: 3, bravo: 1 } } }));
  check('an unnormalized distribution is normalized', sumsToOne(Object.values(unnormalized.probabilities)));
  check('normalization preserves the ratio', unnormalized.probabilities.alpha === 0.75);

  // --- a genuine near-tie ----------------------------------------------------

  const tie = await ask(() => ({ pick: { distribution: { alpha: 0.5, echo: 0.5 } } }));
  check(
    'an exact tie still reports a single argmax choice',
    tie.choice === 'alpha' || tie.choice === 'echo',
  );
  check('an exact tie keeps both masses equal', tie.probabilities.alpha === tie.probabilities.echo);

  // --- rejections ------------------------------------------------------------

  let rejectedUnknown = false;
  try {
    await ask(() => ({ pick: { distribution: { nonexistent: 1 } } }));
  } catch (error) {
    rejectedUnknown = String(error).includes('nonexistent');
  }
  check('mass on an option that does not exist is rejected', rejectedUnknown);

  let rejectedEmpty = false;
  try {
    await ask(() => ({ pick: { distribution: { alpha: 0, bravo: 0 } } }));
  } catch (error) {
    rejectedEmpty = String(error).includes('positive mass');
  }
  check('a distribution with no positive mass is rejected', rejectedEmpty);

  let rejectedNegative = false;
  try {
    await ask(() => ({ pick: { distribution: { alpha: -1 } } }));
  } catch (error) {
    rejectedNegative = String(error).includes('positive mass');
  }
  check('a wholly negative distribution is rejected', rejectedNegative);

  // --- the existing shorthand still works ------------------------------------

  const peaked = await ask(() => ({ pick: { choice: 'charlie', strength: 0.9 } }));
  check('the choice shorthand still selects its target', peaked.choice === 'charlie');
  check('the choice shorthand still honours strength', peaked.probabilities.charlie === 0.9);

  const unscripted = await ask(() => ({}));
  check('an unscripted question still answers deterministically', unscripted.choice.length > 0);
  check('an unscripted question still sums to 1', sumsToOne(Object.values(unscripted.probabilities)));

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  if (failures > 0) process.exitCode = 1;
}

await main();
