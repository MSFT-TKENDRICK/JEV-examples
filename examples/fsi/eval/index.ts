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
import {
  contradictions,
  defaultGates,
  probeEconomy,
  resolution,
  scoreable,
  sweep,
} from './sweep.ts';

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

    const economy = probeEconomy(run.records);
    if (economy.steps > 0) {
      console.log(`\n  ${bold('Probe economy')} ${dim('(per step, not a trajectory total)')}`);
      if (economy.measurable === 0) {
        console.log(
          dim(
            economy.unmeasured === economy.steps
              ? `    unmeasured — ${economy.steps} probe step(s), none recorded the\n` +
                  `    alternatives they were chosen from, so there is nothing to compare against`
              : `    no comparison to make — of ${economy.steps} probe step(s), ` +
                  `${economy.noAlternatives} had\n    only one probe available and ` +
                  `${economy.unmeasured} did not record the alternatives`,
          ),
        );
      } else {
        const cost = economy.meanCostMultiplier;
        const gain = economy.meanGainMultiplier;
        console.log(
          dim(
            `    ${economy.measurable} of ${economy.steps} step(s) had a real choice; ` +
              `cheapest-first would have differed at ${economy.disagreements}`,
          ),
        );
        if (economy.disagreements === 0) {
          console.log(
            dim(
              '    at every step the cheapest probe was also the one EIG selected —\n' +
                '    on these fixtures the ranking bought nothing over picking the cheapest',
            ),
          );
        } else if (cost !== null && gain !== null) {
          console.log(
            dim(
              `    where they differed: ${cost.toFixed(2)}x the cost for ` +
                `${gain.toFixed(2)}x the expected information`,
            ),
          );
        }
        if (economy.noAlternatives > 0) {
          console.log(
            dim(
              `    ${economy.noAlternatives} step(s) had one probe available and so no ` +
                `choice to make`,
            ),
          );
        }
        if (economy.unmeasured > 0) {
          console.log(
            dim(
              `    ${economy.unmeasured} step(s) unmeasured — the alternatives were not ` +
                `recorded`,
            ),
          );
        }
        if (economy.rankingViolations > 0) {
          console.log(
            `    ${bold(`${economy.rankingViolations} step(s) violate the ranking rule`)} ` +
              dim('— the cheapest probe had better gain-per-cost; this is a bug, not a result'),
          );
        }
      }
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
      'One knob moves here: minSelectedProbability, from 0.50 to 0.95.',
      'minMargin and maxNormalizedEntropy are held fixed, and the probe',
      'thresholds the examples ship — the probe budget, and the gain floors a',
      'probe must clear to be worth buying — are not swept at all. So this is',
      'the sensitivity of one gate, not of the policy. A reader who wants to',
      'know how the probe budget changes behaviour will not find it here, and',
      'nothing in this table should be read as answering it.',
      '',
      'No accuracy is reported. There is no correct answer recorded against',
      'these fixtures, and the distributions were manufactured, so any accuracy',
      'figure would describe the fixture author rather than the model. The same',
      'caution applies to the entropy removed: the prior was scripted, so the',
      'posterior is a consequence of the script.',
      '',
      'Probe economy compares EIG selection against cheapest-first at each',
      'recorded step, and only there. It deliberately reports no trajectory',
      'total: running a different probe first would have produced a different',
      'observation and a different posterior, so every step after the first is',
      'unknowable from a trail that policy never generated. A cost multiplier',
      'above the gain multiplier means the ranking is not paying for itself on',
      'these fixtures, and the run prints that rather than hiding it.',
      '',
      'The live instrument is examples/fsi/eval/perturb.ts. It has never been run.',
    ])}`,
  );
}

await main();
