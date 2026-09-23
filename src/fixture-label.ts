/**
 * The scripted-fixture disclosure.
 *
 * Explicit `JEV_MOCK=1` runs use `src/mock-fetch.ts`, which manufactures both the
 * selected answer *and* the shape of the distribution. That
 * matters more than "the data is synthetic": the model's behaviour is scripted
 * too. An offline run can therefore demonstrate what the application does with a
 * distribution — it cannot demonstrate that the distribution deserves trust.
 *
 * Two adversarial design reviews landed on the same instruction: say so where the
 * reader is actually looking, not in a footnote. So this banner prints to the
 * terminal on every run and is meant to be visible in any recording.
 */

import { activeBackend, backendLabel } from './client.ts';
import { bold, dim, red, yellow } from './ui.ts';

export type RunMode = 'SCRIPTED_MOCK' | 'LIVE_API' | 'LOCAL_MODEL';

export function runMode(live: boolean): RunMode {
  if (!live) return 'SCRIPTED_MOCK';
  return activeBackend() === 'local' ? 'LOCAL_MODEL' : 'LIVE_API';
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
  'Calls go to Jev through Vercel AI Gateway. Responses are not scripted.',
  'Accuracy, calibration and domain suitability are still unvalidated for your data.',
];

const LOCAL_BODY = [
  'Calls go to the open Laya model through the local proxy. Responses are not',
  'scripted, but they are NOT Jev: same wire format, different model and calibration.',
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
    const local = activeBackend() === 'local';
    console.log(`\n${dim(rule)}`);
    console.log(bold(yellow(local ? '  LOCAL LAYA MODEL — JEV-COMPATIBLE API, NOT JEV' : '  LIVE JEV VIA VERCEL AI GATEWAY')));
    for (const line of local ? LOCAL_BODY : LIVE_BODY) console.log(dim(`  ${line}`));
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
  if (!live) return 'SCRIPTED_MOCK — model judgment and distribution are predetermined';
  return activeBackend() === 'local'
    ? `LOCAL_MODEL — ${backendLabel()}; responses not scripted; accuracy still unvalidated`
    : 'LIVE_API — responses not scripted; accuracy still unvalidated';
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
  if (live && activeBackend() === 'local') {
    return (
      '> **Local Laya model through a Jev-compatible proxy — not Jev.** Responses are not scripted.\n' +
      '> Accuracy, calibration and domain suitability remain unvalidated for your data.\n\n'
    );
  }
  return live
    ? '> **Live Jev via Vercel AI Gateway.** Responses are not scripted. Accuracy, calibration\n' +
        '> and domain suitability remain unvalidated for your data.\n\n'
    : `> **${SCRIPTED_HEADLINE}**\n>\n` +
        SCRIPTED_BODY.map((line) => `> ${line}`).join('\n') +
        '\n\n';
}
