/**
 * 05 — The same loop, against a real browser, recorded.
 *
 * Example 04 makes the argument with a simulated page so it runs anywhere.
 * This one proves the argument holds against a real DOM: Chrome launches, the
 * interactive elements come from the actual document, Jev gets exactly the same
 * five questions, and the click is a real input event at real coordinates.
 *
 * Everything that is not the decision lives in `src/browser-driver.ts`, shared
 * with example 06. The policy lives in `src/browser-policy.ts`, shared verbatim
 * with example 04. What is left in this file is only the part that is about
 * Jev.
 *
 * `webreel` drives the cursor animation and the click overlay and encodes the
 * result, so the output is evidence rather than a claim.
 *
 * Requirements: this one is NOT zero-setup. webreel downloads Chrome and ffmpeg
 * into ~/.webreel on first run (a few hundred MB). That is why it is opt-in and
 * not part of `npm run all`.
 *
 * Honesty: without TYPESAFE_API_KEY the judgements below are replayed from the
 * script, so the recording is evidence that the loop and the driver work — not
 * that Jev picks these particular elements. Set the key for a genuinely live run.
 *
 * Run:  npm run record
 *       npm run record -- --no-video
 */

import { resolve } from 'node:path';

import { createClient } from '../src/client.ts';
import type { PageElement, Status } from '../src/browser-policy.ts';
import { buildQuestions, decide } from '../src/browser-policy.ts';
import type { ScriptedAnswer } from '../src/mock-fetch.ts';
import { selectedProbability } from '../src/rubric.ts';
import type { Arm, PageView } from '../src/browser-driver.ts';
import { runArm } from '../src/browser-driver.ts';
import { banner, bold, cyan, dim, green, pct, title, yellow } from '../src/ui.ts';

const task = 'Find the monthly price of the Pro plan.';
const record = !process.argv.includes('--no-video');
const outputPath = resolve(import.meta.dirname, '..', 'docs', 'media', 'browser-use.mp4');

/** Scripted Jev judgements, keyed by page. See the honesty note above. */
const script: Record<string, Record<string, ScriptedAnswer>> = {
  'pricing.html': {
    // Two cookie buttons, both plausible, neither dominant.
    target: { choice: 'e5', strength: 0.46 },
    verb: { choice: 'click', strength: 0.97 },
    goalMet: { noul: 0.01 },
    blocked: { noul: 0.04 },
    looping: { noul: 0.02 },
  },
  'plans.html': {
    target: { choice: 'e5', strength: 0.91 },
    verb: { choice: 'click', strength: 0.98 },
    goalMet: { noul: 0.03 },
    blocked: { noul: 0.02 },
    looping: { noul: 0.02 },
  },
  'pro.html': {
    target: { choice: 'none', strength: 0.86 },
    verb: { choice: 'click', strength: 0.6 },
    goalMet: { noul: 0.96 },
    blocked: { noul: 0.01 },
    looping: { noul: 0.02 },
  },
};

/** The human in the loop, as in example 04. Prefers declining cookies. */
function askAPerson(
  shortlist: { option: string; probability: number }[],
  elements: PageElement[],
): string | undefined {
  const reject = elements.find((element) => /reject/i.test(element.label));
  return reject && shortlist.some((option) => option.option === reject.id) ? reject.id : undefined;
}

const jev = createClient((body) => script[(body.state as { url?: string }).url ?? ''] ?? {});

const arm: Arm = {
  label: 'Jev · System One',
  detail: jev.live ? 'live' : 'replayed locally',
  async decide(page: PageView) {
    const state = { task, url: page.url, visibleText: page.text };
    const { answers } = await jev.client.systemOne({
      state,
      questions: buildQuestions(page.elements),
    });

    const lines = [
      `\n${bold(page.url)}  ${dim(
        `${page.elements.length} candidates · ~${Math.ceil(JSON.stringify(state).length / 4)} tokens of page state`,
      )}`,
      `  target=${answers.target.choice} ${dim(
        `p=${pct(selectedProbability(answers.target))} · goalMet=${pct(answers.goalMet.noul)}`,
      )}`,
    ];

    const decision = decide(answers);

    if (decision.kind === 'terminal') {
      return {
        decision: { kind: 'terminal' as const, status: decision.status, reason: decision.reason },
        lines: [...lines, `  ${green(decision.status.toUpperCase())} ${decision.reason}`],
        caption: decision.status === 'done' ? 'answer found' : decision.status,
      };
    }

    if (decision.kind === 'escalate') {
      lines.push(`  ${yellow('AMBIGUOUS')} distribution is split; not clicking on a coin flip`);
      for (const option of decision.shortlist) {
        const element = page.elements.find((candidate) => candidate.id === option.option);
        lines.push(
          `    ${option.option} "${element?.label ?? option.option}" ${pct(option.probability)}`,
        );
      }

      const resolved = askAPerson(decision.shortlist, page.elements);
      if (!resolved) {
        return {
          decision: {
            kind: 'terminal' as const,
            status: 'ambiguous' as Status,
            reason: 'no human decision available',
          },
          lines: [...lines, `  ${yellow('HALT')} returning the shortlist`],
          caption: 'halted — asking a human',
        };
      }

      const chosen = page.elements.find((candidate) => candidate.id === resolved);
      return {
        decision: { kind: 'act' as const, elementId: resolved },
        lines: [...lines, `  ${green('HUMAN')} chose "${chosen?.label ?? resolved}"`],
        caption: `asked a human → "${chosen?.label ?? resolved}"`,
      };
    }

    const chosen = page.elements.find((candidate) => candidate.id === decision.elementId);
    return {
      decision: { kind: 'act' as const, elementId: decision.elementId },
      lines: [...lines, `  ${green('ACT')}   click "${chosen?.label ?? decision.elementId}"`],
      caption: `click "${chosen?.label ?? decision.elementId}"`,
    };
  },
};

// ---------------------------------------------------------------------------
title('05 — The same loop, against real Chrome, recorded');
banner(jev.live);
console.log(dim('launching chrome (first run downloads it into ~/.webreel)'));

const result = await runArm({
  arm,
  entry: 'pricing.html',
  ...(record ? { outputPath } : {}),
});

title('Result');
console.log(`  status  ${bold(result.status)}`);
console.log(`  page    ${result.finalPage}`);
console.log(`  steps   ${result.history.length ? result.history.join(' → ') : '(none)'}`);
if (result.answer) console.log(`  answer  ${cyan(result.answer.slice(0, 120))}`);
if (result.videoPath) console.log(`  video   ${result.videoPath}`);

console.log(
  `\n${dim(
    'Everything above happened in a real browser: the elements came from the DOM,\n' +
      'the cursor moved, and the clicks were real input events. The Jev judgements\n' +
      'are scripted, because this repo has no API key — so the recording is\n' +
      'evidence that the loop and the driver work, not that Jev picks these\n' +
      'particular elements. Set TYPESAFE_API_KEY to record a genuinely live run.',
  )}`,
);
