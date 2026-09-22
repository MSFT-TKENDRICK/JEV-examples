/**
 * 04 — Browser use: selecting actions instead of generating them.
 *
 * There is no official TypeSafe browser-use example. The architecture below is
 * the one the best community implementations converge on, and it follows
 * directly from what Jev is: a model that picks from options you supply and
 * never writes free text.
 *
 * The loop:
 *   1. settle    wait for the DOM to go quiet
 *   2. describe  YOUR CODE enumerates candidate elements and compacts the page
 *   3. evaluate  one Jev request: which element, what verb, done? error? risky?
 *   4. act       your driver (Playwright, CDP, whatever) performs the action
 *
 * Two consequences worth internalizing:
 *
 *   - Because the candidate list comes from the DOM, the model cannot
 *     hallucinate a selector. It can only pick a real element or `none`.
 *   - Because the page description is a compact element list rather than raw
 *     HTML, each step costs hundreds of tokens instead of tens of thousands.
 *
 * Low confidence is not a failure — it is a status. The loop turns a split
 * distribution into `ambiguous` and hands back a ranked shortlist rather than
 * clicking on a coin flip. The agent never resolves its own ambiguity: a
 * person (here, a scripted stand-in) picks from the shortlist, or the run ends.
 *
 * Run:  node examples/04-browser-use.ts
 */

import { choice, noul } from '@typesafe-ai/sdk';
import { createClient } from '../src/client.ts';
import type { ScriptedAnswer } from '../src/mock-fetch.ts';
import { isAmbiguous, rankedOptions, selectedProbability } from '../src/rubric.ts';
import { banner, bold, cyan, dim, green, pct, red, title, yellow } from '../src/ui.ts';

const task = 'Find the monthly price of the Pro plan.';

interface Element {
  id: string;
  role: 'button' | 'link' | 'tab' | 'input';
  label: string;
  /** Marks actions that cannot be undone. Code, not the model, decides policy. */
  destructive?: boolean;
}

interface Page {
  url: string;
  text: string;
  elements: Element[];
}

/** A simulated site, so the example runs with no browser installed. */
const pages: Record<string, Page> = {
  '/pricing': {
    url: '/pricing',
    text: 'Pricing — choose a plan. We use cookies to improve your experience.',
    elements: [
      { id: 'e1', role: 'button', label: 'Accept all cookies' },
      { id: 'e2', role: 'button', label: 'Reject non-essential cookies' },
      { id: 'e3', role: 'link', label: 'Compare plans' },
      { id: 'e4', role: 'link', label: 'Delete my account', destructive: true },
    ],
  },
  '/pricing#plans': {
    url: '/pricing#plans',
    text: 'Starter, Pro and Enterprise. Toggle billing period to see prices.',
    elements: [
      { id: 'e5', role: 'tab', label: 'Monthly billing' },
      { id: 'e6', role: 'tab', label: 'Annual billing' },
      { id: 'e7', role: 'link', label: 'Pro plan details' },
      { id: 'e8', role: 'link', label: 'Enterprise plan details' },
    ],
  },
  '/pricing/pro': {
    url: '/pricing/pro',
    text: 'Pro plan — $49 per user per month, billed monthly. Includes SSO and priority support.',
    elements: [
      { id: 'e9', role: 'button', label: 'Start free trial' },
      { id: 'e10', role: 'link', label: 'Back to plans' },
    ],
  },
};

/** The simulated driver. In real code this is Playwright. */
function act(current: Page, elementId: string): Page {
  if (current.url === '/pricing' && (elementId === 'e1' || elementId === 'e2')) {
    return pages['/pricing#plans'] as Page;
  }
  if (current.url === '/pricing' && elementId === 'e3') return pages['/pricing#plans'] as Page;
  if (current.url === '/pricing#plans' && elementId === 'e7') return pages['/pricing/pro'] as Page;
  return current;
}

/**
 * Step 2: describe. This is ordinary code, and it is where the token savings
 * live. Jev sees a short structured summary, never the raw DOM.
 */
function describe(page: Page, history: string[]) {
  return {
    task,
    url: page.url,
    visibleText: page.text,
    candidates: Object.fromEntries(
      page.elements.map((element) => [element.id, `${element.role}: ${element.label}`]),
    ),
    stepsTaken: history,
  };
}

/** Step 3's questions. Built per page because the option set is the page. */
function buildQuestions(page: Page) {
  const candidates: Record<string, string> = Object.fromEntries(
    page.elements.map((element) => [element.id, `${element.role} labelled "${element.label}"`]),
  );

  return {
    // The model selects from real elements. It cannot invent a selector.
    target: choice(
      'Which single element in `candidates` should be actioned next to make progress on `task`?',
      { ...candidates, none: 'No element on this page helps with the task' },
    ),
    verb: choice('What interaction does the chosen element require?', {
      click: 'Press a button, link or tab',
      type: 'Enter text into an input',
      select: 'Choose a value from a list',
    }),
    goalMet: noul('Does `visibleText` already contain the answer to `task`?', {
      true: 'The specific value asked for is present in the visible text',
      false: 'The value is not shown yet',
    }),
    blocked: noul('Is the page showing a login wall, paywall, captcha or hard error?'),
    looping: noul('Do `stepsTaken` show the same action being repeated without effect?'),
  };
}

/** Scripted judgments per step, keyed by URL. */
const scripts: Record<string, Record<string, ScriptedAnswer>> = {
  '/pricing': {
    target: { choice: 'e1', strength: 0.46 },
    verb: { choice: 'click', strength: 0.97 },
    goalMet: { noul: 0.01 },
    blocked: { noul: 0.04 },
    looping: { noul: 0.02 },
  },
  '/pricing#plans': {
    target: { choice: 'e7', strength: 0.91 },
    verb: { choice: 'click', strength: 0.98 },
    goalMet: { noul: 0.03 },
    blocked: { noul: 0.02 },
    looping: { noul: 0.02 },
  },
  '/pricing/pro': {
    target: { choice: 'none', strength: 0.86 },
    verb: { choice: 'click', strength: 0.6 },
    goalMet: { noul: 0.96 },
    blocked: { noul: 0.01 },
    looping: { noul: 0.02 },
  },
};

type Status =
  | 'running'
  | 'done'
  | 'ambiguous'
  | 'needs_confirmation'
  | 'blocked'
  | 'stuck'
  | 'max_steps';

/**
 * The human in the loop. A real harness posts the shortlist to a queue, a chat
 * message or an approval UI and waits. Returning `undefined` — nobody is
 * available to decide — must end the run, not license a guess.
 *
 * This stand-in answers the one escalation this scripted site produces.
 */
function askAPerson(shortlist: { option: string; probability: number }[]): string | undefined {
  const answers: Record<string, string> = {
    // Both cookie buttons dismiss the banner; a person knows to decline.
    e1: 'e2',
  };
  return shortlist[0] ? answers[shortlist[0].option] : undefined;
}

title('04 — Browser use: pick an element, never invent one');

let page = pages['/pricing'] as Page;
const history: string[] = [];
let status: Status = 'running';
let answer: string | undefined;
let live = false;
const MAX_STEPS = 6;

for (let step = 0; step < MAX_STEPS; step++) {
  const questions = buildQuestions(page);
  const script = scripts[page.url] ?? {};
  const picked = createClient(() => script);
  live = picked.live;
  if (step === 0) banner(live);

  const state = describe(page, history);
  const { answers } = await picked.client.systemOne({ state, questions });

  const { target, verb, goalMet, blocked, looping } = answers;
  const targetProbability = selectedProbability(target);

  console.log(`\n${bold(`step ${step + 1}`)}  ${cyan(page.url)}`);
  console.log(
    `  ${dim(
      `${page.elements.length} candidates · ~${Math.ceil(JSON.stringify(state).length / 4)} tokens of page state`,
    )}`,
  );
  console.log(
    `  target=${target.choice} ${dim(
      `p=${pct(targetProbability)} · confidence=${pct(target.confidence)} · ` +
        `goalMet=${pct(goalMet.noul)}`,
    )}`,
  );

  // --- Terminal conditions, checked by code, highest severity first. -------
  if (blocked.noul >= 0.7) {
    status = 'blocked';
    console.log(`  ${red('BLOCKED')} login wall or hard error`);
    break;
  }
  if (goalMet.noul >= 0.85) {
    status = 'done';
    answer = page.text;
    console.log(`  ${green('DONE')} answer found on this page`);
    break;
  }
  if (looping.noul >= 0.7) {
    status = 'stuck';
    console.log(`  ${yellow('STUCK')} repeating without effect`);
    break;
  }
  if (target.choice === 'none') {
    status = 'stuck';
    console.log(`  ${yellow('STUCK')} no element on this page advances the task`);
    break;
  }

  // --- Low confidence becomes a status, not a guess. ----------------------
  let chosenId: string = target.choice;

  if (isAmbiguous(target, 0.6)) {
    console.log(`  ${yellow('AMBIGUOUS')} distribution is split; not clicking on a coin flip`);
    const ranked = rankedOptions(target).slice(0, 3);
    console.log(`  ${dim('shortlist handed to the caller:')}`);
    for (const option of ranked) {
      const element = page.elements.find((candidate) => candidate.id === option.option);
      console.log(`    ${option.option} "${element?.label ?? option.option}" ${pct(option.probability)}`);
    }

    const decision = askAPerson(ranked);
    if (!decision) {
      // Nobody available to decide. The run ends here; it does not guess.
      status = 'ambiguous';
      console.log(`  ${yellow('HALT')} no human decision available — returning the shortlist`);
      break;
    }
    chosenId = decision;
    const picked = page.elements.find((candidate) => candidate.id === decision);
    console.log(`  ${green('HUMAN')} chose ${decision} "${picked?.label ?? decision}"`);
  }

  const element = page.elements.find((candidate) => candidate.id === chosenId);
  if (!element) {
    status = 'stuck';
    break;
  }

  // --- Irreversibility is a code rule, driven off the DOM, not the model. --
  if (element.destructive) {
    status = 'needs_confirmation';
    console.log(`  ${red('CONFIRM')} "${element.label}" is irreversible — handing to a human`);
    break;
  }

  console.log(`  ${green('ACT')}   ${verb.choice} ${element.id} "${element.label}"`);
  history.push(`${verb.choice} "${element.label}"`);
  page = act(page, element.id);

  if (step === MAX_STEPS - 1) status = 'max_steps';
}

// ---------------------------------------------------------------------------
title('Result');
console.log(`  status  ${bold(status)}`);
console.log(`  url     ${page.url}`);
console.log(`  steps   ${history.length ? history.join(' → ') : '(none)'}`);
if (answer) console.log(`  answer  ${cyan(answer)}`);

console.log(
  `\n${dim(
    'The model never produced a selector, a URL or a sentence. It chose among\n' +
      'elements your code already found, and your code turned those choices —\n' +
      'plus their probabilities — into a status a caller can act on.',
  )}`,
);
