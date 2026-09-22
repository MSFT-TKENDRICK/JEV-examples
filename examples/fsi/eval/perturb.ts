/**
 * Candidate-set perturbation — the live instrument.
 *
 * ## Status: this has never been run
 *
 * Not once, against anything. No result in this repository was produced by it,
 * and no claim anywhere rests on it. It ships as runnable code rather than as a
 * table of numbers precisely because producing that table would require a real
 * key and a real service, and fabricating one would be the single most damaging
 * thing this repository could do.
 *
 * ## The question it exists to ask
 *
 * A threshold over a distribution is only meaningful if the distribution is
 * stable under changes that ought not to matter. Adding an irrelevant option,
 * removing an unchosen one, or simply reordering the list are all things an
 * application does routinely as a catalog evolves — and none of them should move
 * the mass on an unrelated answer very much.
 *
 * If they do, then a threshold calibrated against one option set does not
 * transfer to another, and every number in the offline sweep is a property of
 * one particular catalog rather than of the policy. That is a question about the
 * service, so only the service can answer it.
 *
 * ## How to run it
 *
 * ```
 * TYPESAFE_API_KEY=... node examples/fsi/eval/perturb.ts
 * ```
 *
 * Record what comes back, including the date and the model version. Do not
 * quote a result from one run as a property of the service.
 */

import { TypeSafeClient } from '@typesafe-ai/sdk';
import { bold, dim, note, title } from '../../../src/ui.ts';

export interface Perturbation {
  label: string;
  optionIds: readonly string[];
}

/**
 * Builds the perturbations for one option set: the baseline, one with an
 * unrelated option added, one with the lowest-mass option removed, and one
 * merely reordered.
 */
export function perturbationsOf(
  optionIds: readonly string[],
  spurious: string,
  dropped: string,
): Perturbation[] {
  return [
    { label: 'baseline', optionIds },
    { label: `added ${spurious}`, optionIds: [...optionIds, spurious] },
    { label: `removed ${dropped}`, optionIds: optionIds.filter((id) => id !== dropped) },
    { label: 'reordered', optionIds: [...optionIds].reverse() },
  ];
}

async function main(): Promise<void> {
  title('FSI eval — candidate-set perturbation');

  if (!process.env['TYPESAFE_API_KEY']) {
    console.log(
      note([
        'TYPESAFE_API_KEY is not set, so nothing ran — which is also the state',
        'this file has been in for its entire existence. It has never been',
        'executed against the live service, by anyone, and no result in this',
        'repository came from it.',
        '',
        'Set a key to run it. Whatever it prints is a measurement of one service',
        'version on one day, not a property of the service.',
      ]),
    );
    return;
  }

  console.log(
    note([
      'Running against the live TypeSafe API. Responses are not scripted.',
      'This measures the stability of the distribution under changes to the',
      'option set. It does not measure accuracy, and it establishes nothing',
      'about whether the answers are correct.',
    ]),
  );

  const client = new TypeSafeClient();
  console.log(`\n${bold('  perturbation')}  ${dim('selected → mass')}`);
  console.log(dim('  (implement the state and question for the option set under test)'));
  // Deliberately left to the reader: the state and question belong to the
  // catalog being tested, and inventing one here would produce a number that
  // looks like evidence while measuring nothing in particular.
  void client;
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
