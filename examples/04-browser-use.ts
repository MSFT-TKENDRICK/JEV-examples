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

import { createClient } from '../src/client.ts';
import type { PageElement, Status } from '../src/browser-policy.ts';
import { buildQuestions, decide } from '../src/browser-policy.ts';
import type { ScriptedAnswer } from '../src/mock-fetch.ts';
import { selectedProbability } from '../src/rubric.ts';
import { banner, bold, cyan, dim, green, pct, red, title, yellow } from '../src/ui.ts';

const task = 'Find the monthly price of the Pro plan.';

interface Page {
  url: string;
  text: string;
  elements: PageElement[];
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
  const questions = buildQuestions(page.elements);
  const script = scripts[page.url] ?? {};
  const picked = createClient(() => script);
  live = picked.live;
  if (step === 0) banner(live);

  const state = describe(page, history);
  const { answers } = await picked.client.systemOne({ state, questions });

  const { target, verb, goalMet } = answers;

  console.log(`\n${bold(`step ${step + 1}`)}  ${cyan(page.url)}`);
  console.log(
    `  ${dim(
      `${page.elements.length} candidates · ~${Math.ceil(JSON.stringify(state).length / 4)} tokens of page state`,
    )}`,
  );
  console.log(
    `  target=${target.choice} ${dim(
      `p=${pct(selectedProbability(target))} · confidence=${pct(target.confidence)} · ` +
        `goalMet=${pct(goalMet.noul)}`,
    )}`,
  );

  // --- The decision. Shared verbatim with example 05's real-browser loop. --
  const decision = decide(answers);
  let chosenId: string;

  if (decision.kind === 'terminal') {
    status = decision.status;
    if (status === 'done') answer = page.text;
    const paint = status === 'done' ? green : status === 'blocked' ? red : yellow;
    console.log(`  ${paint(status.toUpperCase())} ${decision.reason}`);
    break;
  }

  if (decision.kind === 'escalate') {
    console.log(`  ${yellow('AMBIGUOUS')} distribution is split; not clicking on a coin flip`);
    console.log(`  ${dim('shortlist handed to the caller:')}`);
    for (const option of decision.shortlist) {
      const element = page.elements.find((candidate) => candidate.id === option.option);
      console.log(
        `    ${option.option} "${element?.label ?? option.option}" ${pct(option.probability)}`,
      );
    }

    const resolved = askAPerson(decision.shortlist);
    if (!resolved) {
      // Nobody available to decide. The run ends here; it does not guess.
      status = 'ambiguous';
      console.log(`  ${yellow('HALT')} no human decision available — returning the shortlist`);
      break;
    }
    chosenId = resolved;
    const chosen = page.elements.find((candidate) => candidate.id === resolved);
    console.log(`  ${green('HUMAN')} chose ${resolved} "${chosen?.label ?? resolved}"`);
  } else {
    chosenId = decision.elementId;
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
