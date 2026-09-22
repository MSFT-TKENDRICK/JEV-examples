/**
 * Thin, runtime-checked wrappers for asking a single question.
 *
 * A probe is one question asked on its own — that is what makes it cost
 * something and therefore what makes choosing between probes meaningful. Ask
 * them in a batch and there is nothing left to select.
 *
 * The question name is built at the call site, so the SDK cannot infer the
 * answer type for it. Rather than casting, these check `type` at runtime and
 * throw on a shape they did not ask for. The SDK does not validate responses,
 * so this is the only place the guarantee can come from.
 */

import type {
  ChoiceQuestion,
  ChoiceResponse,
  EntryType,
  ScoreQuestion,
  ScoreResponse,
  TypeSafeClient,
} from '@typesafe-ai/sdk';

async function askOne(
  client: TypeSafeClient,
  state: EntryType,
  name: string,
  question: ScoreQuestion | ChoiceQuestion,
): Promise<unknown> {
  const { answers } = await client.systemOne({ state, questions: { [name]: question } });
  return answers[name];
}

export async function askScore(
  client: TypeSafeClient,
  state: EntryType,
  name: string,
  question: ScoreQuestion,
): Promise<ScoreResponse> {
  const answer = await askOne(client, state, name, question);
  if (
    typeof answer !== 'object' ||
    answer === null ||
    (answer as { type?: unknown }).type !== 'score'
  ) {
    throw new Error(`Expected a score answer for "${name}", got ${JSON.stringify(answer)}`);
  }
  return answer as ScoreResponse;
}

export async function askChoice(
  client: TypeSafeClient,
  state: EntryType,
  name: string,
  question: ChoiceQuestion,
): Promise<ChoiceResponse> {
  const answer = await askOne(client, state, name, question);
  if (
    typeof answer !== 'object' ||
    answer === null ||
    (answer as { type?: unknown }).type !== 'choice'
  ) {
    throw new Error(`Expected a choice answer for "${name}", got ${JSON.stringify(answer)}`);
  }
  return answer as ChoiceResponse;
}

/** The level a Score answer put the most mass on, which is not always `round(score)`. */
export function argmaxLevel(answer: ScoreResponse): number {
  let best = 0;
  let bestMass = -1;
  for (const [level, mass] of Object.entries(answer.probabilities)) {
    if (mass > bestMass) {
      bestMass = mass;
      best = Number(level);
    }
  }
  return best;
}
