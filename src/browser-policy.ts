/**
 * The browser-use policy, shared by the simulated example (04) and the real
 * Chrome example (05).
 *
 * Splitting this out makes the actual claim of those examples testable: the
 * questions you ask and the rules you apply to the answers do not depend on
 * whether the page is a literal object or a live DOM. Only `describe` and `act`
 * change. If you swap Playwright for CDP, this file is untouched.
 */

import { choice, noul } from '@typesafe-ai/sdk';
import { isAmbiguous, rankedOptions } from './rubric.ts';

/** One interactive element your driver found on the page. */
export interface PageElement {
  id: string;
  role: 'button' | 'link' | 'tab' | 'input';
  label: string;
  /** Marks actions that cannot be undone. Code, not the model, decides policy. */
  destructive?: boolean;
}

/** What `describe` produces: a compact page, never raw HTML. */
export interface PageSnapshot {
  url: string;
  text: string;
  elements: PageElement[];
}

export type Status =
  | 'running'
  | 'done'
  | 'ambiguous'
  | 'needs_confirmation'
  | 'blocked'
  | 'stuck'
  | 'max_steps';

/**
 * The questions, built per page because the option set *is* the page.
 *
 * `none` matters: without an explicit escape hatch the model is forced to
 * nominate an element even when nothing on the page helps.
 */
export function buildQuestions(elements: PageElement[]) {
  const candidates: Record<string, string> = Object.fromEntries(
    elements.map((element) => [element.id, `${element.role} labelled "${element.label}"`]),
  );

  return {
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

/** Thresholds, gathered in one place so they are obviously tunable. */
export const THRESHOLDS = {
  blocked: 0.7,
  goalMet: 0.85,
  looping: 0.7,
  /** Below this selected probability, the choice is treated as a coin flip. */
  confident: 0.6,
} as const;

export type Decision =
  | { kind: 'terminal'; status: Exclude<Status, 'running' | 'ambiguous'>; reason: string }
  | { kind: 'escalate'; shortlist: { option: string; probability: number }[] }
  | { kind: 'act'; elementId: string };

/**
 * Turn answers into a decision. Ordered by severity, most serious first.
 *
 * Note what this function never does: it never picks between close options.
 * Ambiguity leaves here as `escalate`, and the caller decides whether a human
 * is available. That is the difference between a shortlist and a guess.
 */
export function decide(answers: {
  target: { choice: string; probabilities: { readonly [key: string]: number } };
  goalMet: { noul: number };
  blocked: { noul: number };
  looping: { noul: number };
}): Decision {
  const { target, goalMet, blocked, looping } = answers;

  if (blocked.noul >= THRESHOLDS.blocked) {
    return { kind: 'terminal', status: 'blocked', reason: 'login wall or hard error' };
  }
  if (goalMet.noul >= THRESHOLDS.goalMet) {
    return { kind: 'terminal', status: 'done', reason: 'answer found on this page' };
  }
  if (looping.noul >= THRESHOLDS.looping) {
    return { kind: 'terminal', status: 'stuck', reason: 'repeating without effect' };
  }
  if (target.choice === 'none') {
    return {
      kind: 'terminal',
      status: 'stuck',
      reason: 'no element on this page advances the task',
    };
  }
  if (isAmbiguous(target, THRESHOLDS.confident)) {
    return { kind: 'escalate', shortlist: rankedOptions(target).slice(0, 3) };
  }
  return { kind: 'act', elementId: target.choice };
}
