/**
 * The control: a browsing policy driven by an ordinary generative model.
 *
 * This is the thing Jev is being compared against, and it is deliberately not a
 * straw man. It gets the same page description, the same task, the same loop
 * and the same driver. It uses `generateObject` from the Vercel AI SDK with a
 * strict schema, which is the standard way to make a language model drive a UI.
 * It is even allowed to report that it has hit a dead end, so that it can ask
 * to back up - the schema below has `deadEnd` for exactly that reason.
 *
 * The difference is what comes back: one element id, plus a self-reported
 * confidence. Self-reported confidence is a token the model chose, drawn from
 * the same distribution as the rest of its output - it is not a measurement,
 * and it is well known to be poorly calibrated. More importantly for this
 * repo, one id is one id. It ranks nothing else, so:
 *
 *   - the beam is one wide, and "back up to the second-best branch" has no
 *     second-best to name, even when the agent correctly asks to back up;
 *   - the prior is a point mass, so expected information gain is exactly zero
 *     for every probe and probe selection has nothing to choose between.
 *
 * Neither of those is a claim about model quality. A generative model made to
 * emit scores over the candidate list would drive the same machinery. The
 * deficiency is in the single answer.
 *
 * Only explicit `AI_GATEWAY_GENERATIVE=1` enables paid Gateway generation.
 * Otherwise it replays a script
 * through `MockLanguageModelV4` and sleeps for `thinkMs` to stand in for
 * generation time. That stand-in is declared everywhere it is shown.
 */

import { generateObject } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModel } from 'ai';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { z } from 'zod';

import type { Judge } from './site/walk.ts';
import { describe } from './site/walk.ts';
import { TASK } from './site/graph.ts';
import { isLiveGeneration } from './client.ts';

export const browseSchema = z.object({
  done: z.boolean().describe('True if the task has been carried out and the page confirms it.'),
  atTarget: z
    .boolean()
    .describe('True if the action the task asks for is performed on this page, not a later one.'),
  deadEnd: z.boolean().describe('True if this page proves the current route cannot work.'),
  elementId: z.string().describe('The id of the element to action next, or "none".'),
  confidence: z.number().min(0).max(1).describe('How sure you are, from 0 to 1.'),
});

export type BrowseAction = z.infer<typeof browseSchema>;

/** Gateway model id for the control arm. Override with CONTROL_MODEL. */
export const CONTROL_MODEL = process.env['CONTROL_MODEL'] ?? 'openai/gpt-5.6-terra';

/** Stand-in generation latency when there is no key. Declared, not measured. */
export const CONTROL_THINK_MS = Number(process.env['CONTROL_THINK_MS'] ?? 2600);

export interface ControlOptions {
  /** Scripted replies per page id, for offline runs. */
  scripted: Record<string, BrowseAction>;
  /** Overrides the stand-in generation latency. */
  thinkMs?: number;
  label?: string;
}

/**
 * The control arm as a `Judge`, so it runs through the identical loop.
 *
 * `beamWidth: 1` is not a handicap applied to it. It is what a single answer
 * affords: there is no second path to keep, because no second path was named.
 */
export function createControlJudge(options: ControlOptions): Judge & { live: boolean } {
  const live = isLiveGeneration();
  const thinkMs = options.thinkMs ?? CONTROL_THINK_MS;

  let current: BrowseAction | undefined;
  const replay = async (): Promise<LanguageModelV4GenerateResult> => {
    // The sleep is inside the model, not around the call, so a measured
    // decision time covers the same span it would for a real generation.
    if (thinkMs > 0) await new Promise((done) => setTimeout(done, thinkMs));
    return {
      content: [{ type: 'text', text: JSON.stringify(current) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      },
      warnings: [],
    };
  };

  const model: LanguageModel = live
    ? gateway(CONTROL_MODEL)
    : new MockLanguageModelV4({ doGenerate: replay });

  return {
    label: options.label ?? 'control',
    detail: `${live ? CONTROL_MODEL : `${CONTROL_MODEL} replayed`}, one id per page, beam width 1`,
    beamWidth: 1,
    live,

    async judge(site, history) {
      current = options.scripted[site.id] ?? {
        done: false,
        atTarget: false,
        deadEnd: false,
        elementId: site.elements[0]?.id ?? 'none',
        confidence: 0.5,
      };

      const { object } = await generateObject({
        model,
        schema: browseSchema,
        system:
          'You are browsing a website to carry out a task. You are given the visible text and ' +
          'the actionable elements. Choose the single element most likely to advance the task, ' +
          'and say whether the task is done, whether it is carried out on this page, and whether ' +
          'this page proves the route cannot work. Never invent an element id.',
        prompt: JSON.stringify({ task: TASK, page: describe(site, history) }),
      });

      // The whole of the difference. One id becomes all of the mass, because
      // one id is all there was.
      return {
        prior: { [object.elementId]: 1 },
        signals: {
          goalMet: object.done ? 0.97 : 0.02,
          atTarget: object.atTarget ? 0.93 : 0.05,
          deadEnd: object.deadEnd ? 0.94 : 0.03,
        },
      };
    },
  };
}
