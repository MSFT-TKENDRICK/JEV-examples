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
import { contradictions, defaultGates, resolution, scoreable, sweep } from './sweep.ts';

const pad = (value: string | number, width: number) => String(value).padStart(width);

function table(rows: ReturnType<typeof sweep>): void {
  console.log(
    `  ${bold('min mass')}  ${bold(pad('scored', 6))}  ${bold(pad('acts', 6))}  ` +
      `${bold(pad('investigates', 12))}  ${bold(pad('contradicted', 12))}`,
  );
  for (const row of rows) {
    console.log(
      `  ${pad(row.gate.minSelectedProbability.toFixed(2), 8)}  ${pad(row.scored, 6)}  ` +
        `${pad(row.acted, 6)}  ${pad(row.investigated, 12)}  ${pad(row.contradicted, 12)}`,
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

    const summary = resolution(run.records);
    console.log(`\n  ${bold('What this run actually did')} ${dim('(recorded, not swept)')}`);
    console.log(
      dim(
        `    ${summary.actedImmediately} acted with no probe, ` +
          `${summary.resolvedByProbing} resolved by probing, ` +
          `${summary.refusedAfterProbing} refused after probing\n` +
          `    ${summary.probesSpent} probe(s), ${summary.probeCost} cost unit(s), ` +
          `${summary.entropyRemoved.toFixed(3)} nats of entropy removed`,
      ),
    );
    if (summary.inconsistent > 0) {
      console.log(
        `    ${bold(`${summary.inconsistent} run(s) ended inconsistent`)} ` +
          dim('— partial effects the compensator could not undo'),
      );
    }

    // Worth naming when it happens, because it is the opposite of what a
    // reader expects a threshold table to show.
    const inverted = rows.filter((r) => r.acted > 0 && r.contradicted === r.acted);
    if (inverted.length > 0) {
      const first = inverted[0]?.gate.minSelectedProbability.toFixed(2);
      console.log(
        dim(
          `\n  at min mass ${first} and above, every decision this policy still acts on\n` +
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
      'Raising the mass threshold trades acting for investigating, which is the',
      'tradeoff the table is for. What it cannot do is remove the rows above.',
      'Those recommendations cleared every distribution test and were still',
      'wrong enough for deterministic code to refuse them, so no amount of',
      'threshold tuning would have caught them. That is the argument for',
      'keeping the deterministic checks, not for picking a better number.',
      '',
      'The investigates column counts decisions that would need more evidence',
      'at that threshold. It does not predict that probing would find it — the',
      'probes that ran were chosen against the shipped gate, not this one.',
      '',
      'No accuracy is reported. There is no correct answer recorded against',
      'these fixtures, and the distributions were manufactured, so any accuracy',
      'figure would describe the fixture author rather than the model. The same',
      'caution applies to the entropy removed: the prior was scripted, so the',
      'posterior is a consequence of the script.',
      '',
      'The live instrument is examples/fsi/eval/perturb.ts. It has never been run.',
    ])}`,
  );
}

await main();
