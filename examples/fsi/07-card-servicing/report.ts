/** Rendering for the 07 run. No decisions are made in this file. */

import type { PlanResult } from '../../../src/compensate.ts';
import type { Assessment } from '../../../src/information-gain.ts';
import type { DistributionMetrics } from '../../../src/ledger.ts';
import type { Eligibility, Rejection, StepSpec } from '../../../src/workflow-machine.ts';
import { bars, bold, cyan, dim, green, note, pct, red, yellow } from '../../../src/ui.ts';
import { failedTests } from './policy.ts';
import type { PolicyDecision } from './policy.ts';

export function printEligibility(eligibility: Eligibility): void {
  console.log(
    `  ${dim('option set built by code from')} ` +
      `${cyan(`${eligibility.source}@${eligibility.version}`)} ${dim(`read ${eligibility.readAt}`)}`,
  );
  const offered = eligibility.eligible.map((step) => step.id).join(', ');
  console.log(`  ${green('offered')}  ${offered || '(none)'}`);
  for (const excluded of eligibility.excluded) {
    console.log(`  ${dim('withheld')} ${dim(`${excluded.id} — ${excluded.reason}`)}`);
  }
}

export function printDistribution(
  probabilities: Readonly<Record<string, number>> | null,
  metrics: DistributionMetrics | null,
): void {
  if (!probabilities || !metrics) return;
  bars({ ...probabilities }, { indent: '    ', limit: 8 });
  const failed = failedTests(metrics);
  const verdict = failed.length === 0 ? green('passes all three tests') : yellow(failed.join('; '));
  console.log(
    `    ${dim(
      `p=${pct(metrics.selectedProbability)} · margin=${metrics.margin.toFixed(2)} · ` +
        `entropy=${metrics.normalizedEntropy.toFixed(2)} · over ${metrics.optionCount} offered options`,
    )}`,
  );
  console.log(`    ${verdict}`);
}

export function printRoute(decision: PolicyDecision): void {
  const tag =
    decision.route === 'act'
      ? green('ACT')
      : decision.route === 'probe'
        ? cyan('PROBE')
        : red('REFUSE');
  console.log(`  ${tag} ${dim(decision.reason)}`);
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/**
 * The whole ranking, not just the winner.
 *
 * Printing only the chosen probe would make the selection unfalsifiable — a
 * reader could not tell whether it beat anything. The rejected alternatives and
 * their numbers are the evidence that a choice was made.
 */
export function printProbeRanking(ranked: readonly Assessment[], chosenId: string | null): void {
  if (ranked.length === 0) {
    console.log(`    ${dim('no probe scored above the minimum gain')}`);
    return;
  }

  const width = Math.max(...ranked.map((entry) => entry.probe.id.length), 6);
  console.log(
    `    ${bold('probe'.padEnd(width))}  ${bold('cost')}  ${bold('  E[gain]')}  ${bold('gain/cost')}`,
  );
  for (const entry of ranked) {
    const chosen = entry.probe.id === chosenId;
    const marker = chosen ? green('→') : ' ';
    const id = chosen ? green(entry.probe.id.padEnd(width)) : entry.probe.id.padEnd(width);
    console.log(
      `  ${marker} ${id}  ${String(entry.probe.cost).padStart(4)}  ` +
        `${entry.expectedInformationGain.toFixed(4).padStart(8)}  ` +
        `${entry.gainPerCost.toFixed(4).padStart(9)}`,
    );
  }
}

export function printObservation(
  probeId: string,
  reads: string,
  observation: string,
  detail: string,
  priorEntropy: number,
  posteriorEntropy: number,
): void {
  console.log(
    `    ${cyan('read')} ${bold(probeId)} ${dim(`(${reads})`)} → ${bold(observation)}`,
  );
  console.log(note([detail, `entropy ${priorEntropy.toFixed(4)} → ${posteriorEntropy.toFixed(4)} nats`], 6));
}

/** The point-estimate demonstration: zero entropy in, zero gain out, for every probe. */
export function printDegenerateAssessments(assessments: readonly Assessment[]): void {
  const width = Math.max(...assessments.map((entry) => entry.probe.id.length), 6);
  for (const entry of assessments) {
    console.log(
      `    ${entry.probe.id.padEnd(width)}  ` +
        `prior H=${entry.priorEntropy.toFixed(4)}  ` +
        `E[posterior H]=${entry.expectedPosteriorEntropy.toFixed(4)}  ` +
        `E[gain]=${entry.expectedInformationGain.toFixed(4)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Plans and execution
// ---------------------------------------------------------------------------

/** The ordered plan, with each step's reversibility on the face of it. */
export function printPlan(
  steps: readonly { id: string; description: string; reversible: boolean }[],
  digest: string,
): void {
  console.log(`  ${bold('plan')} ${dim(`${steps.length} step(s) · digest ${digest}`)}`);
  for (const [index, step] of steps.entries()) {
    const tag = step.reversible ? green('reversible') : red('irreversible');
    console.log(`    ${dim(`${index + 1}.`)} ${bold(step.id)}  ${tag}`);
    console.log(note(step.description, 7));
  }
}

/**
 * The execution, including the rollback.
 *
 * Compensations are listed in the order they actually ran — the reverse of the
 * plan — because "we roll back in reverse order" is the kind of claim that
 * should be readable off the output rather than taken from a comment.
 */
export function printExecution(result: PlanResult): void {
  const tag =
    result.outcome === 'completed'
      ? green('COMPLETED')
      : result.outcome === 'rolled_back'
        ? yellow('ROLLED BACK')
        : result.outcome === 'inconsistent'
          ? red('INCONSISTENT')
          : red('REFUSED');
  console.log(`  ${tag} ${dim(result.reason)}`);

  for (const record of result.steps) {
    const mark = record.verified ? green('✓') : record.acted ? yellow('!') : dim('·');
    console.log(`    ${mark} ${record.id} ${dim(record.detail)}`);
  }

  const compensated = [...result.steps].reverse().filter((record) => record.compensated !== undefined);
  if (compensated.length > 0) {
    console.log(`    ${dim('compensating in reverse plan order:')}`);
    for (const record of compensated) {
      const mark = record.compensated ? green('↩') : red('✗');
      const detail = record.compensated
        ? 'undone'
        : `compensation failed: ${record.compensationError ?? 'unknown'}`;
      console.log(`      ${mark} ${record.id} ${dim(detail)}`);
    }
  }

  if (result.inconsistentAt !== undefined) {
    console.log(
      note(
        [
          `the records are in an unintended state at "${result.inconsistentAt}".`,
          'This is reported rather than retried: a runner that retried here would be',
          'guessing about a world it has already failed to read correctly.',
        ],
        4,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export function printRejections(arm: string, rejections: readonly Rejection[]): void {
  console.log(`  ${red('REJECTED')} ${bold(arm)} ${dim('— by bindArguments, before execution')}`);
  for (const rejection of rejections) {
    console.log(`    ${red('✗')} ${rejection.slot}=${dim(rejection.proposed)}`);
    console.log(`      ${dim(rejection.reason)}`);
  }
}

export function printBound(
  bound: Readonly<Record<string, { value: string; boundTo: string }>>,
): void {
  for (const [name, value] of Object.entries(bound)) {
    const shown = value.value.length > 48 ? `${value.value.slice(0, 45)}...` : value.value;
    console.log(`    ${green('✓')} ${name}=${shown}`);
    console.log(`      ${dim(`bound to ${value.boundTo}`)}`);
  }
}

/** What undoing this step would mean, named before it is taken. */
export function printReversal(step: StepSpec): void {
  if (step.reversible) {
    console.log(`  ${green('reversible')} ${dim(step.reversal ?? 'undo path not recorded')}`);
  } else {
    console.log(`  ${red('irreversible')} ${dim('no undo path exists — this is a point of no return')}`);
  }
  console.log(note([`verified by: ${step.verification}`, `if verification fails: ${step.residueIfUnverified}`], 4));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface SummaryRow {
  readonly scenario: string;
  readonly recommended: string;
  readonly route: string;
  readonly probes: string;
  readonly executed: string;
  readonly outcome: string;
  readonly baseline: string;
}

export function printSummary(rows: readonly SummaryRow[]): void {
  const width = (values: readonly string[], header: string): number =>
    Math.max(...values.map((value) => value.length), header.length);

  const widths = {
    scenario: width(rows.map((row) => row.scenario), 'scenario'),
    recommended: width(rows.map((row) => row.recommended), 'jev recommended'),
    route: width(rows.map((row) => row.route), 'route'),
    probes: width(rows.map((row) => row.probes), 'probes'),
    executed: width(rows.map((row) => row.executed), 'harness executed'),
    outcome: width(rows.map((row) => row.outcome), 'outcome'),
  };

  console.log(
    `  ${bold('scenario'.padEnd(widths.scenario))}  ${bold('jev recommended'.padEnd(widths.recommended))}  ` +
      `${bold('route'.padEnd(widths.route))}  ${bold('probes'.padEnd(widths.probes))}  ` +
      `${bold('harness executed'.padEnd(widths.executed))}  ${bold('outcome'.padEnd(widths.outcome))}  ` +
      `${bold('baseline')}`,
  );

  for (const row of rows) {
    const diverged = row.recommended !== row.executed && row.recommended !== '(none)';
    const executed = diverged
      ? yellow(row.executed.padEnd(widths.executed))
      : row.executed.padEnd(widths.executed);
    console.log(
      `  ${row.scenario.padEnd(widths.scenario)}  ${row.recommended.padEnd(widths.recommended)}  ` +
        `${row.route.padEnd(widths.route)}  ${row.probes.padEnd(widths.probes)}  ` +
        `${executed}  ${row.outcome.padEnd(widths.outcome)}  ${dim(row.baseline)}`,
    );
  }
}
