/**
 * The control: a browsing policy driven by an ordinary generative model.
 *
 * This is the thing Jev is being compared against, and it is deliberately not a
 * straw man. It gets the same page description, the same task and the same
 * driver. It uses `generateObject` from the Vercel AI SDK with a strict schema,
 * which is the standard way to make a language model drive a UI.
 *
 * The difference is what comes back. This returns one element id and a
 * self-reported confidence. Self-reported confidence is a token the model
 * chose, drawn from the same distribution as the rest of its output — it is
 * not a measurement of anything, and it is well known to be poorly calibrated.
 * So a harness built on it has nothing trustworthy to gate on: either you
 * believe the number, or you act on every answer. This arm acts on every
 * answer, which is what most agents in production actually do.
 *
 * With `AI_GATEWAY_API_KEY` set this is a real Gateway call and the latency in
 * the comparison is a real measurement. Without one it replays a script
 * through `MockLanguageModelV4` and sleeps for `CONTROL_THINK_MS` to stand in
 * for generation time. That stand-in is declared everywhere it is shown.
 */

import { generateObject } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModel } from 'ai';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { z } from 'zod';

import type { PageView } from './browser-driver.ts';

export const browseSchema = z.object({
  done: z.boolean().describe('True if the answer is already visible on this page.'),
  answer: z.string().describe('The answer, if done. Otherwise an empty string.'),
  elementId: z.string().describe('The id of the element to click next, or "none" if done.'),
  confidence: z.number().min(0).max(1).describe('How sure you are, from 0 to 1.'),
});

export type BrowseAction = z.infer<typeof browseSchema>;

/** Gateway model id for the control arm. Override with CONTROL_MODEL. */
const CONTROL_MODEL = process.env['CONTROL_MODEL'] ?? 'openai/gpt-5.6-terra';

/** Stand-in generation latency when there is no key. Declared, not measured. */
export const CONTROL_THINK_MS = Number(process.env['CONTROL_THINK_MS'] ?? 2600);

export interface ControlAgent {
  modelId: string;
  live: boolean;
  act(page: PageView, task: string, history: string[]): Promise<BrowseAction>;
}

export function createControlAgent(scripted: Record<string, BrowseAction>): ControlAgent {
  const live = Boolean(process.env['AI_GATEWAY_API_KEY']) && process.env['JEV_MOCK'] !== '1';

  let current: BrowseAction | undefined;
  const replay = async (): Promise<LanguageModelV4GenerateResult> => {
    // The sleep is inside the model, not around the call, so the measured
    // decision time covers the same span it would for a real generation.
    await new Promise((done) => setTimeout(done, CONTROL_THINK_MS));
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
    modelId: CONTROL_MODEL,
    live,
    async act(page, task, history) {
      current = scripted[page.url] ?? {
        done: false,
        answer: '',
        elementId: page.elements[0]?.id ?? 'none',
        confidence: 0.5,
      };

      const { object } = await generateObject({
        model,
        schema: browseSchema,
        system:
          'You are browsing a website to answer a question. You are given the ' +
          'visible text and the clickable elements. Choose the single element ' +
          'most likely to lead to the answer, or report done when the answer ' +
          'is already on the page. Never invent an element id.',
        prompt: JSON.stringify({ task, page, history }),
      });

      return object;
    },
  };
}
