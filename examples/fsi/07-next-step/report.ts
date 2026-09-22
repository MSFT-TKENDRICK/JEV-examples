/** Rendering for the 07 run. No decisions are made in this file. */

import type { DistributionMetrics } from '../../../src/ledger.ts';
import type { Eligibility, Rejection } from '../../../src/workflow-machine.ts';
import { bars, bold, cyan, dim, green, pct, red, yellow } from '../../../src/ui.ts';
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
    decision.route === 'auto'
      ? green('AUTO')
      : decision.route === 'approval_required'
        ? cyan('APPROVAL')
        : decision.route === 'escalated'
          ? yellow('ESCALATE')
          : red('REFUSE');
  console.log(`  ${tag} ${dim(decision.reason)}`);
}

export function printRejections(arm: string, rejections: readonly Rejection[]): void {
  console.log(`  ${red('REJECTED')} ${bold(arm)} ${dim('— by bindArguments, before execution')}`);
  for (const rejection of rejections) {
    console.log(`    ${red('✗')} ${rejection.slot}=${dim(rejection.proposed)}`);
    console.log(`      ${dim(rejection.reason)}`);
  }
}

export function printBound(bound: Readonly<Record<string, { value: string; boundTo: string }>>): void {
  for (const [name, value] of Object.entries(bound)) {
    const shown = value.value.length > 48 ? `${value.value.slice(0, 45)}...` : value.value;
    console.log(`    ${green('✓')} ${name}=${shown}`);
    console.log(`      ${dim(`bound to ${value.boundTo}`)}`);
  }
}

export interface SummaryRow {
  readonly scenario: string;
  readonly recommended: string;
  readonly route: string;
  readonly executed: string;
  readonly baseline: string;
}

export function printSummary(rows: readonly SummaryRow[]): void {
  const widths = {
    scenario: Math.max(...rows.map((row) => row.scenario.length), 8),
    recommended: Math.max(...rows.map((row) => row.recommended.length), 11),
    route: Math.max(...rows.map((row) => row.route.length), 5),
    executed: Math.max(...rows.map((row) => row.executed.length), 8),
  };

  console.log(
    `  ${bold('scenario'.padEnd(widths.scenario))}  ${bold('jev recommended'.padEnd(widths.recommended))}  ` +
      `${bold('route'.padEnd(widths.route))}  ${bold('harness executed'.padEnd(widths.executed))}  ${bold('baseline')}`,
  );

  for (const row of rows) {
    const diverged = row.recommended !== row.executed && row.recommended !== '(none)';
    const executed = diverged ? yellow(row.executed.padEnd(widths.executed)) : row.executed.padEnd(widths.executed);
    console.log(
      `  ${row.scenario.padEnd(widths.scenario)}  ${row.recommended.padEnd(widths.recommended)}  ` +
        `${row.route.padEnd(widths.route)}  ${executed}  ${dim(row.baseline)}`,
    );
  }
}
