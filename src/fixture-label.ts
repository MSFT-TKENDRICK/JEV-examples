/**
 * The scripted-fixture disclosure.
 *
 * Every FSI example in this repo runs offline by default, and `src/mock-fetch.ts`
 * manufactures both the selected answer *and* the shape of the distribution. That
 * matters more than "the data is synthetic": the model's behaviour is scripted
 * too. An offline run can therefore demonstrate what the application does with a
 * distribution — it cannot demonstrate that the distribution deserves trust.
 *
 * Two adversarial design reviews landed on the same instruction: say so where the
 * reader is actually looking, not in a footnote. So this banner prints to the
 * terminal on every run and is meant to be visible in any recording.
 */

import { bold, dim, red, yellow } from './ui.ts';

export type RunMode = 'SCRIPTED_MOCK' | 'LIVE_API';

export function runMode(live: boolean): RunMode {
  return live ? 'LIVE_API' : 'SCRIPTED_MOCK';
}

const SCRIPTED_HEADLINE =
  'SCRIPTED OFFLINE FIXTURE — MODEL JUDGMENT AND DISTRIBUTION ARE PREDETERMINED';

const SCRIPTED_BODY = [
  'This run demonstrates application control flow, not model accuracy.',
  'No customer or transaction data is used. No live TypeSafe API call is made.',
  'No domain validation has been performed. Thresholds are illustrative, not',
  'empirically selected. Draw no regulatory conclusion from this output.',
];

const LIVE_BODY = [
  'Calls go to the real TypeSafe API. Responses are not scripted.',
  'Accuracy, calibration and domain suitability are still unvalidated for your data.',
];

/**
 * Prints the run-mode disclosure. Call this first in every FSI example, before
 * any other output, so it cannot scroll away unnoticed in a short recording.
 */
export function fixtureBanner(live: boolean): void {
  const width = Math.max(SCRIPTED_HEADLINE.length + 4, 76);
  const rule = '═'.repeat(width);

  if (live) {
    console.log(`\n${dim(rule)}`);
    console.log(bold(yellow('  LIVE TYPESAFE API')));
    for (const line of LIVE_BODY) console.log(dim(`  ${line}`));
    console.log(`${dim(rule)}\n`);
    return;
  }

  console.log(`\n${red(rule)}`);
  console.log(bold(red(`  ${SCRIPTED_HEADLINE}`)));
  console.log(red('─'.repeat(width)));
  for (const line of SCRIPTED_BODY) console.log(dim(`  ${line}`));
  console.log(`${red(rule)}\n`);
}

/**
 * The same disclosure as a single line, for overlays, footers and log records
 * where the full block does not fit.
 */
export function fixtureTag(live: boolean): string {
  return live
    ? 'LIVE_API — responses not scripted; accuracy still unvalidated'
    : 'SCRIPTED_MOCK — model judgment and distribution are predetermined';
}

/**
 * The disclosure as Markdown, so an example can emit a README fragment or a PR
 * comment carrying the same wording as its terminal output.
 *
 * Ends with a blank line. Without it, CommonMark lazy continuation pulls the
 * following paragraph *into* the blockquote — so the prose after a disclosure
 * would render as part of the disclosure.
 */
export function fixtureMarkdown(live: boolean): string {
  return live
    ? '> **Live TypeSafe API.** Responses are not scripted. Accuracy, calibration\n' +
        '> and domain suitability remain unvalidated for your data.\n\n'
    : `> **${SCRIPTED_HEADLINE}**\n>\n` +
        SCRIPTED_BODY.map((line) => `> ${line}`).join('\n') +
        '\n\n';
}
