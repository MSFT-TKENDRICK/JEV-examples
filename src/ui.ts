/** Small console helpers so the examples read like reports, not log dumps. */

import type { Verdict } from './rubric.ts';
import { backendLabel } from './client.ts';

const supportsColor =
  process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

const wrap = (code: string, text: string) =>
  supportsColor ? `\u001b[${code}m${text}\u001b[0m` : text;

export const bold = (text: string) => wrap('1', text);
export const dim = (text: string) => wrap('2', text);
export const green = (text: string) => wrap('32', text);
export const yellow = (text: string) => wrap('33', text);
export const red = (text: string) => wrap('31', text);
export const cyan = (text: string) => wrap('36', text);

export function title(text: string): void {
  console.log(`\n${bold(text)}\n${dim('─'.repeat(Math.max(text.length, 40)))}`);
}

export function banner(live: boolean): void {
  console.log(
    live
      ? dim(`transport: ${backendLabel()} (@typesafe-ai/sdk)`)
      : dim('transport: SCRIPTED_MOCK (JEV_MOCK=1) — no Jev inference; unset JEV_MOCK to use Gateway credentials'),
  );
}

/** Turns a score answer's `legend` into bar-chart labels. */
export function legendLabels(legend: {
  readonly [score: string]: unknown;
}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(legend).map(([index, description]) => [
      index,
      `${index} ${typeof description === 'string' ? description : ''}`.trimEnd(),
    ]),
  );
}

/** Renders a probability distribution as a sorted bar chart. */
export function bars(
  distribution: Record<string, number> | undefined,
  options: { indent?: string; limit?: number; labels?: Record<string, string> } = {},
): void {
  if (!distribution) {
    console.log(`${options.indent ?? '  '}${dim('(no distribution returned)')}`);
    return;
  }
  const { indent = '  ', limit = 10, labels } = options;
  const entries = Object.entries(distribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  const width = Math.max(...entries.map(([key]) => (labels?.[key] ?? key).length));

  for (const [key, probability] of entries) {
    const label = (labels?.[key] ?? key).padEnd(width);
    const filled = Math.round(probability * 24);
    const bar = '█'.repeat(filled) + dim('·'.repeat(24 - filled));
    console.log(`${indent}${label}  ${bar} ${(probability * 100).toFixed(1).padStart(5)}%`);
  }
}

export function verdictColor(verdict: Verdict): string {
  if (verdict === 'pass') return green('PASS');
  if (verdict === 'investigate') return yellow('INVESTIGATE');
  return red('FAIL');
}

export function pct(value: number | undefined): string {
  return value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

/**
 * A dimmed, indented block of continuation lines.
 *
 * Both FSI examples were indenting explanatory lines by hand at every call
 * site, which is how the same paragraph ends up at three different indents.
 * Blank lines are preserved as blank rather than as indented whitespace.
 */
export function note(lines: string | readonly string[], indent = 4): string {
  const list = typeof lines === 'string' ? lines.split('\n') : lines;
  const pad = ' '.repeat(indent);
  return list.map((line) => (line.trim() === '' ? '' : `${pad}${dim(line)}`)).join('\n');
}
