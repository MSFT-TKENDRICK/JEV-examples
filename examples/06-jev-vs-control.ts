/**
 * 06 — Jev against a control model, same task, same page, side by side.
 *
 * Both arms run through `src/browser-driver.ts`: same Chrome, same DOM, same
 * describe step, same click mechanics, same irreversibility guard. The only
 * thing that differs is what decides.
 *
 *   Jev      one `systemOne` call returning a distribution over the elements,
 *            plus four scalar judgements. The harness reads the shape of that
 *            distribution and refuses to act when it is flat.
 *
 *   Control  one `generateObject` call returning a single element id and a
 *            self-reported confidence — the standard generative agent loop.
 *            There is no distribution to inspect, so there is nothing to gate
 *            on, and it acts on every answer.
 *
 * Two things show up in the recording. Jev decides faster, because scoring a
 * fixed set of options is a smaller job than writing a JSON object. And on the
 * ambiguous step Jev stops, while the control proceeds confidently — not
 * because it is a worse model, but because the harness around it was handed one
 * answer instead of a distribution and had nothing to check.
 *
 * HONESTY, and this matters for reading the video:
 *   - Without TYPESAFE_API_KEY, Jev's judgements are replayed from the script
 *     below and its decision time is ~0 because nothing leaves the process.
 *   - Without AI_GATEWAY_API_KEY, the control's choices are likewise scripted,
 *     and its latency is CONTROL_THINK_MS (default 2600ms), a declared
 *     stand-in for a real generation, not a measurement.
 *   - Set both keys and every number in the summary becomes a real measurement.
 * The recording is evidence that the loops behave as described. It is not a
 * benchmark, and the caption on each video says which mode it ran in.
 *
 * Run:  npm run compare
 *       npm run compare -- --no-video
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

import { createClient } from '../src/client.ts';
import type { PageElement, Status } from '../src/browser-policy.ts';
import { buildQuestions, decide } from '../src/browser-policy.ts';
import type { ScriptedAnswer } from '../src/mock-fetch.ts';
import { selectedProbability } from '../src/rubric.ts';
import type { Arm, PageView, RunResult } from '../src/browser-driver.ts';
import { runArm } from '../src/browser-driver.ts';
import type { BrowseAction } from '../src/control-agent.ts';
import { CONTROL_THINK_MS, createControlAgent } from '../src/control-agent.ts';
import { prepareFfmpeg, stackSideBySide, toGif } from '../src/compose.ts';
import { bold, cyan, dim, green, pct, title, yellow } from '../src/ui.ts';

const task = 'Find the monthly price of the Pro plan.';
const record = !process.argv.includes('--no-video');
const media = resolve(import.meta.dirname, '..', 'docs', 'media');

/** Identical beats for both arms, so the side-by-side compares decisions. */
const beats = { start: 1400, settle: 900, afterClick: 1600, end: 2200 };

// --- Jev's scripted judgements ---------------------------------------------
const jevScript: Record<string, Record<string, ScriptedAnswer>> = {
  'pricing.html': {
    // Two cookie buttons, both plausible, neither dominant. This is the step
    // the harness is meant to stop on.
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

// --- The control's scripted answers ----------------------------------------
// One id, one self-reported number, no distribution. Note the 0.82 on the step
// Jev refuses: a confident-looking number on a genuinely ambiguous choice is
// exactly the failure mode, and it is why self-reported confidence is not a
// gate.
const controlScript: Record<string, BrowseAction> = {
  'pricing.html': { done: false, answer: '', elementId: 'e5', confidence: 0.82 },
  'plans.html': { done: false, answer: '', elementId: 'e5', confidence: 0.88 },
  'pro.html': {
    done: true,
    answer: '$49 per user per month',
    elementId: 'none',
    confidence: 0.91,
  },
};

/** The human in the loop. Prefers declining cookies. */
function askAPerson(
  shortlist: { option: string; probability: number }[],
  elements: PageElement[],
): string | undefined {
  const reject = elements.find((element) => /reject/i.test(element.label));
  return reject && shortlist.some((option) => option.option === reject.id) ? reject.id : undefined;
}

// --- Arm A: Jev -------------------------------------------------------------
const jevClient = createClient((body) => {
  const url = (body.state as { url?: string }).url ?? '';
  return jevScript[url] ?? {};
});

const jevArm: Arm = {
  label: 'Jev · System One',
  detail: jevClient.live ? 'live' : 'replayed locally',
  async decide(page: PageView) {
    const { answers } = await jevClient.client.systemOne({
      state: { task, url: page.url, visibleText: page.text },
      questions: buildQuestions(page.elements),
    });

    const lines = [
      `  ${dim(`${page.elements.length} candidates`)}  target=${answers.target.choice} ` +
        dim(`p=${pct(selectedProbability(answers.target))} · goalMet=${pct(answers.goalMet.noul)}`),
    ];

    const decision = decide(answers);

    if (decision.kind === 'terminal') {
      return {
        decision: { kind: 'terminal', status: decision.status, reason: decision.reason },
        lines: [...lines, `  ${green(decision.status.toUpperCase())} ${decision.reason}`],
        caption: decision.status === 'done' ? 'answer found' : decision.status,
      };
    }

    if (decision.kind === 'escalate') {
      lines.push(`  ${yellow('AMBIGUOUS')} distribution is split — not clicking on a coin flip`);
      for (const option of decision.shortlist) {
        const element = page.elements.find((candidate) => candidate.id === option.option);
        lines.push(`    ${option.option} "${element?.label ?? option.option}" ${pct(option.probability)}`);
      }

      const resolved = askAPerson(decision.shortlist, page.elements);
      if (!resolved) {
        return {
          decision: { kind: 'terminal', status: 'ambiguous' as Status, reason: 'no human available' },
          lines: [...lines, `  ${yellow('HALT')} returning the shortlist`],
          caption: 'halted — asking a human',
        };
      }

      const chosen = page.elements.find((candidate) => candidate.id === resolved);
      return {
        decision: { kind: 'act', elementId: resolved },
        lines: [...lines, `  ${green('HUMAN')} chose "${chosen?.label ?? resolved}"`],
        caption: `asked a human → "${chosen?.label ?? resolved}"`,
      };
    }

    const chosen = page.elements.find((candidate) => candidate.id === decision.elementId);
    return {
      decision: { kind: 'act', elementId: decision.elementId },
      lines: [...lines, `  ${green('ACT')} click "${chosen?.label ?? decision.elementId}"`],
      caption: `click "${chosen?.label ?? decision.elementId}"`,
    };
  },
};

// --- Arm B: the control -----------------------------------------------------
const control = createControlAgent(controlScript);

const controlArm: Arm = {
  label: 'Control · generative model',
  detail: control.live ? `${control.modelId} · live` : `${control.modelId} · replayed, +${CONTROL_THINK_MS}ms`,
  async decide(page: PageView, history: string[]) {
    const action = await control.act(page, task, history);

    const lines = [
      `  ${dim(`${page.elements.length} candidates`)}  pick=${action.elementId} ` +
        dim(`self-reported confidence=${pct(action.confidence)}`),
    ];

    if (action.done) {
      return {
        decision: { kind: 'terminal', status: 'done' as Status, reason: action.answer },
        lines: [...lines, `  ${green('DONE')} ${action.answer}`],
        caption: 'answer found',
      };
    }

    const chosen = page.elements.find((candidate) => candidate.id === action.elementId);
    return {
      decision: { kind: 'act', elementId: action.elementId },
      lines: [...lines, `  ${green('ACT')} click "${chosen?.label ?? action.elementId}"`],
      caption: `click "${chosen?.label ?? action.elementId}"`,
    };
  },
};

// ---------------------------------------------------------------------------
title('06 — Jev vs a control model, same task, same page');

await mkdir(media, { recursive: true });

console.log(
  dim(
    jevClient.live
      ? 'jev: live TypeSafe API'
      : 'jev: replayed locally (no TYPESAFE_API_KEY) — decision time is ~0 by construction',
  ),
);
console.log(
  dim(
    control.live
      ? `control: live via the AI Gateway (${control.modelId})`
      : `control: replayed (no AI_GATEWAY_API_KEY) — latency is a declared ${CONTROL_THINK_MS}ms stand-in`,
  ),
);

const results: Record<string, RunResult> = {};

for (const [key, arm] of [
  ['jev', jevArm],
  ['control', controlArm],
] as const) {
  console.log(`\n${bold(arm.label)}`);
  results[key] = await runArm({
    arm,
    entry: 'pricing.html',
    beats,
    ...(record ? { outputPath: resolve(media, `compare-${key}.mp4`) } : {}),
  });
}

const jev = results['jev'] as RunResult;
const ctrl = results['control'] as RunResult;

// ---------------------------------------------------------------------------
title('Side by side');

const row = (name: string, a: string, b: string) =>
  console.log(`  ${name.padEnd(18)}${a.padEnd(28)}${b}`);

row('', bold('Jev'), bold('Control'));
row('status', jev.status, ctrl.status);
row('steps', String(jev.steps), String(ctrl.steps));
row('decision time', `${jev.decisionMs}ms`, `${ctrl.decisionMs}ms`);
row('wall clock', `${(jev.totalMs / 1000).toFixed(1)}s`, `${(ctrl.totalMs / 1000).toFixed(1)}s`);

console.log(`\n  ${'clicked'.padEnd(18)}${bold('Jev')}`);
console.log(`  ${''.padEnd(18)}${jev.history.length ? jev.history.join(' → ') : '(none)'}`);
console.log(`  ${''.padEnd(18)}${bold('Control')}`);
console.log(`  ${''.padEnd(18)}${ctrl.history.length ? ctrl.history.join(' → ') : '(none)'}`);

console.log(
  `\n${dim(
    'Both reached the price. The difference is the cookie banner: Jev saw a flat\n' +
      'distribution and stopped to ask, the control saw one answer and clicked it.\n' +
      'Neither model was asked to behave that way — the harness reads what it is given.',
  )}`,
);

if (record && jev.videoPath && ctrl.videoPath) {
  console.log(`\n${dim('composing side-by-side video…')}`);
  await prepareFfmpeg();

  const stacked = resolve(media, 'jev-vs-control.mp4');
  stackSideBySide(
    { path: jev.videoPath, durationSec: jev.totalMs / 1000 },
    { path: ctrl.videoPath, durationSec: ctrl.totalMs / 1000 },
    stacked,
  );
  toGif(stacked, resolve(media, 'jev-vs-control.gif'));

  console.log(`  video  ${cyan(stacked)}`);
  console.log(`  gif    ${cyan(resolve(media, 'jev-vs-control.gif'))}`);
}
