/**
 * The generative half of the harness, on the Vercel AI SDK.
 *
 * Jev judges; it does not write. Something still has to propose the next
 * action, and that is an ordinary language model — here reached through the
 * Vercel AI Gateway, so one key and one credit balance cover every provider.
 *
 * The model Jev routed to is the model this actually calls. That is the payoff
 * of the routing decision in example 03: a cheap classification picks the
 * expensive model only when the task earns it.
 */

import { generateObject } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModel } from 'ai';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { z } from 'zod';

/** A proposed shell command, with the reason the model wants to run it. */
export const proposalSchema = z.object({
  command: z.string().describe('A single shell command to run next.'),
  rationale: z.string().describe('One sentence on what this is expected to reveal.'),
});

export type Proposal = z.infer<typeof proposalSchema>;

/** Jev's route labels mapped to real Gateway model ids. */
const ROUTES = {
  fast: 'openai/gpt-5.6-terra',
  powerful: 'openai/gpt-6-astra',
} as const;

export type Route = keyof typeof ROUTES;

export interface Proposer {
  propose(context: { goal: string; history: unknown; avoid: readonly string[] }): Promise<Proposal>;
  modelId: string;
  live: boolean;
}

/**
 * Builds the proposing model.
 *
 * With `AI_GATEWAY_API_KEY` set, this is a real Gateway call. Without one, it
 * is `MockLanguageModelV4` from `ai/test` replaying `scripted` — the same
 * `generateObject` code path either way, including schema validation.
 */
export function createProposer(route: Route, scripted: readonly Proposal[]): Proposer {
  const modelId = ROUTES[route];
  const live = Boolean(process.env['AI_GATEWAY_API_KEY']) && process.env['JEV_MOCK'] !== '1';

  let next = 0;
  const replay = async (): Promise<LanguageModelV4GenerateResult> => ({
    content: [{ type: 'text', text: JSON.stringify(scripted[next++] ?? scripted.at(-1)) }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    },
    warnings: [],
  });

  const model: LanguageModel = live ? gateway(modelId) : new MockLanguageModelV4({ doGenerate: replay });

  return {
    modelId,
    live,
    async propose(context) {
      const { object } = await generateObject({
        model,
        schema: proposalSchema,
        system:
          'You are debugging a production incident from a read-only shell. ' +
          'Propose exactly one command at a time. Prefer commands that reveal ' +
          'information over commands that change state.',
        prompt: JSON.stringify(context),
      });
      return object;
    },
  };
}
