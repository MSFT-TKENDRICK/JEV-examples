/**
 * The generative control arm — an adversarial fixture.
 *
 * ## Read this before quoting anything from this file
 *
 * This is **not a fair benchmark**, and no comparison here is evidence about
 * generative models in general. It is a scripted `MockLanguageModelV4` replaying
 * a hand-written response chosen to be wrong in a specific way: it names a
 * merchant and a transaction that do not exist, states an amount that does not
 * match the posted one, and paraphrases the customer instead of quoting them.
 *
 * A competent generative implementation can be constrained to enumerated record
 * IDs and put through exactly the same referential checks, and then it passes
 * them for exactly the same reason the Jev arm does — because the checks are in
 * the application, not in the model. The scripted response below is the input
 * this fixture needs to exercise `bindArguments`, nothing more.
 *
 * ## What the fixture does demonstrate
 *
 * That the rejection happens in application code, on the execution path, rather
 * than depending on what the model returned. The same `bindArguments` call runs
 * over this arm's proposal and over the Jev arm's, and the unbound identifiers
 * are rejected on both.
 *
 * It does not demonstrate that Jev prevents hallucinated arguments. Nothing in
 * this example measures that, and the Jev arm is never given the opportunity to
 * produce a free-text identifier in the first place — by construction, not by
 * virtue.
 */

import { generateObject } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { z } from 'zod';

export const toolCallSchema = z.object({
  stepId: z.string().describe('The workflow step to take next.'),
  arguments: z
    .record(z.string(), z.string())
    .describe('Arguments for that step, as strings.'),
});

export type ToolCall = z.infer<typeof toolCallSchema>;

export interface ControlArm {
  readonly modelId: string;
  propose(state: unknown): Promise<ToolCall>;
}

/**
 * Builds the control arm.
 *
 * Offline always, deliberately: this arm exists to emit one specific malformed
 * proposal, and a live model would emit something else. Calling it "the control"
 * is already generous — it is a fixture wearing a control's clothes, and the
 * README fragment says so in those words.
 */
export function createControlArm(scripted: ToolCall): ControlArm {
  const replay = async (): Promise<LanguageModelV4GenerateResult> => ({
    content: [{ type: 'text', text: JSON.stringify(scripted) }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    },
    warnings: [],
  });

  const model = new MockLanguageModelV4({ doGenerate: replay });

  return {
    modelId: 'MockLanguageModelV4 (ai/test) — scripted adversarial fixture',
    async propose(state) {
      // The real `generateObject` code path, including schema validation. Schema
      // validation is the point worth noticing: it proves the *shape* is right
      // and says nothing at all about whether the identifiers exist.
      const { object } = await generateObject({
        model,
        schema: toolCallSchema,
        system:
          'You are a card servicing assistant. Choose the next workflow step and ' +
          'supply its arguments.',
        prompt: JSON.stringify(state),
      });
      return object;
    },
  };
}
