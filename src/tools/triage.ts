/**
 * The generative half of the harness, on the Vercel AI SDK.
 *
 * Jev does not write and does not read tickets. Something has to turn a
 * customer's account of the problem into a short triage note, and that is an
 * ordinary language model — here through the Vercel AI Gateway, so one key
 * covers every provider. Offline it is `MockLanguageModelV4` from `ai/test`
 * replaying a scripted object through the same `generateObject` call, schema
 * validation included.
 *
 * It also returns `suggestedRecordId`, and that field is the interesting one.
 * A model reading a support ticket will happily lift an identifier out of the
 * customer's own prose, and the customer is quite capable of writing down a run
 * id that has never existed. The identifier is schema-valid, well-formed, and
 * plausible. `bind.ts` rejects it anyway, because it does not resolve in the
 * system of record.
 *
 * Which is the honest framing of the control arm: the check is in the
 * application, not in the model. A generative implementation constrained to
 * enumerated identifiers would pass exactly the same check, for exactly the
 * same reason.
 */

import { generateObject } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModel } from 'ai';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { z } from 'zod';

export const triageSchema = z.object({
  summary: z.string().describe('One sentence describing what the customer reported.'),
  suggestedRecordId: z
    .string()
    .describe('Any record identifier the customer named, copied verbatim. Empty if none.'),
});

export type Triage = z.infer<typeof triageSchema>;

export interface Triager {
  triage(ticket: string): Promise<Triage>;
  modelId: string;
  live: boolean;
}

const MODEL_ID = 'openai/gpt-5.6-terra';

export function createTriager(scripted: Triage): Triager {
  const live = Boolean(process.env['AI_GATEWAY_API_KEY']) && process.env['JEV_MOCK'] !== '1';

  const replay = async (): Promise<LanguageModelV4GenerateResult> => ({
    content: [{ type: 'text', text: JSON.stringify(scripted) }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    },
    warnings: [],
  });

  const model: LanguageModel = live
    ? gateway(MODEL_ID)
    : new MockLanguageModelV4({ doGenerate: replay });

  return {
    modelId: MODEL_ID,
    live,
    async triage(ticket: string) {
      const { object } = await generateObject({
        model,
        schema: triageSchema,
        system:
          'You are triaging a support ticket about a data export. Summarize it in one ' +
          'sentence and copy out any record identifier the customer named, verbatim. ' +
          'Do not invent identifiers and do not correct the ones you find.',
        prompt: ticket,
      });
      return object;
    },
  };
}

export function triagerLabel(triager: Triager): string {
  return triager.live
    ? `${triager.modelId} via Vercel AI Gateway`
    : `${triager.modelId} replayed through MockLanguageModelV4 (ai/test)`;
}
