/**
 * FSI eval harness.
 *
 * Runs both FSI examples, reads their decision ledgers, and reports how the
 * policy routes decisions as its thresholds move.
 *
 * Read `sweep.ts` before reading the numbers. In short: this measures a policy
 * applied to distributions that `src/mock-fetch.ts` manufactured. It is not a
 * measurement of Jev, and there is no accuracy column because this repository
 * has no ground truth to compute one against.
 */

import { banner } from '../../../src/ui.ts';
import { bold, dim, note, title } from '../../../src/ui.ts';
import { collect } from './collect.ts';
import { contradictions, defaultGates, scoreable, sweep } from './sweep.ts';

const pad = (value: string | number, width: number) => String(value).padStart(width);

function table(rows: ReturnType<typeof sweep>): void {
  console.log(
    `  ${bold('min mass')}  ${bold(pad('scored', 6))}  ${bold(pad('accepted', 8))}  ` +
      `${bold(pad('escalated', 9))}  ${bold(pad('contradicted', 12))}`,
  );
  for (const row of rows) {
    console.log(
      `  ${pad(row.gate.minSelectedProbability.toFixed(2), 8)}  ${pad(row.scored, 6)}  ` +
        `${pad(row.accepted, 8)}  ${pad(row.escalated, 9)}  ${pad(row.contradicted, 12)}`,
    );
  }
}

async function main(): Promise<void> {
  banner(false);
  title('FSI eval — threshold sensitivity');

  console.log(
    note([
      'Both examples are run as subprocesses and their decision ledgers read',
      'back, so nothing about their pipelines or policies is reimplemented here.',
    ]),
  );

  const runs = collect();
  const gates = defaultGates();

  for (const run of runs) {
    const scored = run.records.filter(scoreable).length;
    const rows = sweep(run.records, gates);
    console.log(`\n${bold(`${run.id} — ${run.title}`)}`);
    console.log(
      dim(
        `  ${run.records.length} decision(s), ${scored} with a usable distribution to threshold on\n`,
      ),
    );
    table(rows);

    // Worth naming when it happens, because it is the opposite of what a
    // reader expects a threshold table to show.
    const inverted = rows.filter((r) => r.accepted > 0 && r.contradicted === r.accepted);
    if (inverted.length > 0) {
      const first = inverted[0]?.gate.minSelectedProbability.toFixed(2);
      console.log(
        dim(
          `\n  at min mass ${first} and above, every decision this policy still accepts\n` +
            `  is one deterministic code went on to veto — tightening the threshold\n` +
            `  discarded the sound acceptances first and kept the confident error`,
        ),
      );
    }
  }

  const found = contradictions(runs);

  console.log(`\n${bold('Accepted, then vetoed by deterministic code')}`);
  console.log(
    dim('  the only column here that is evidence rather than arithmetic\n'),
  );

  if (found.length === 0) {
    console.log(dim('  none in the current fixtures'));
  }
  for (const { run, record } of found) {
    const m = record.metrics;
    console.log(
      `  ${run.id}  ${record.recommendation?.choice ?? '(none)'} ` +
        dim(
          `p=${m?.selectedProbability.toFixed(2)} margin=${m?.margin.toFixed(2)} ` +
            `entropy=${m?.normalizedEntropy.toFixed(2)}`,
        ),
    );
    console.log(dim(`      ${record.policy.reason}`));
    console.log(dim(`      executed instead: ${record.executed.action}`));
  }

  console.log(
    `\n${note([
      'Raising the mass threshold trades coverage for escalation, which is the',
      'tradeoff the table is for. What it cannot do is remove the rows above.',
      'Those recommendations cleared every distribution test and were still',
      'wrong enough for deterministic code to refuse them, so no amount of',
      'threshold tuning would have caught them. That is the argument for',
      'keeping the deterministic checks, not for picking a better number.',
      '',
      'No accuracy is reported. There is no correct answer recorded against',
      'these fixtures, and the distributions were manufactured, so any accuracy',
      'figure would describe the fixture author rather than the model.',
      '',
      'The live instrument is examples/fsi/eval/perturb.ts. It has never been run.',
    ])}`,
  );
}

await main();
