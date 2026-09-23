/**
 * Live candidate-set stability measurement; never part of the offline sweep.
 *
 * Uses example 07's first synthetic case, minimized state, eligible options and
 * question. Four real requests hold the state/question fixed: baseline, add an
 * unrelated test-only option, remove the least-supported unselected action,
 * and reverse the options. Nothing is executed and no fixture answers are read.
 *
 * Run: AI_GATEWAY_API_KEY=... node examples/fsi/eval/perturb.ts
 * VERCEL_OIDC_TOKEN is also supported. Uses free typesafe-ai/jev through Vercel
 * AI Gateway's TypeSafe-compatible endpoint, not a direct TypeSafe account.
 * Do not set JEV_MOCK=1. Output is JSONL with model, time, latency, full
 * distributions and raw shared-option mass deltas. Removal changes
 * normalization; these deltas are descriptive, not an accuracy score or a
 * pass/fail stability threshold. One sample per variant cannot separate
 * sampling variation from option-set effects.
 */

import { choice, VERSION } from '@typesafe-ai/sdk';
import type { JsonValue, TypeSafeClient } from '@typesafe-ai/sdk';
import { createAuthority } from '../../../src/authority.ts';
import { createClient, isLiveJev } from '../../../src/client.ts';
import { runMode } from '../../../src/fixture-label.ts';
import { computeEligibility, NONE_OF_THESE } from '../../../src/workflow-machine.ts';
import {
  buildState,
  nextStepCriteria,
  NEXT_STEP_QUESTION,
} from '../07-next-step/recommend.ts';
import { CARD_IN_SCOPE, SCENARIOS, seed } from '../07-next-step/scenarios.ts';

export interface Perturbation {
  label: string;
  optionIds: readonly string[];
}

export function perturbationsOf(
  optionIds: readonly string[],
  spurious: string,
  dropped: string,
): Perturbation[] {
  return [
    { label: 'baseline', optionIds },
    { label: `added ${spurious}`, optionIds: [...optionIds, spurious] },
    { label: `removed ${dropped}`, optionIds: optionIds.filter((id) => id !== dropped) },
    { label: 'reordered', optionIds: [...optionIds].reverse() },
  ];
}

export interface Measurement extends Perturbation {
  measuredAt: string;
  model: string;
  latencyMs: number;
  choice: string;
  probabilities: Record<string, number>;
  /** Raw mass difference, on options shared with the baseline only. */
  deltasFromBaseline: Record<string, number>;
}

const SPURIOUS = 'test_only_update_mail_preferences';
const SPURIOUS_DESCRIPTION =
  'Update the customer’s marketing mailing preferences. This does not address card payments.';

/** Real SDK requests; callers may inject a test transport, never fixture answers. */
export async function measurePerturbations(
  client: Pick<TypeSafeClient, 'systemOne'>,
  state: Record<string, JsonValue>,
  criteria: Record<string, string>,
  report: (measurement: Measurement) => void = () => {},
): Promise<Measurement[]> {
  const ids = Object.keys(criteria);
  if (ids.length < 3 || SPURIOUS in criteria) {
    throw new Error('Perturbation requires at least three baseline options and no test-only option.');
  }
  const allCriteria: Record<string, string> = { ...criteria, [SPURIOUS]: SPURIOUS_DESCRIPTION };
  const measurements: Measurement[] = [];

  async function measure(variant: Perturbation): Promise<Measurement> {
    const offered = Object.fromEntries(variant.optionIds.map((id) => [id, allCriteria[id]!]));
    const started = performance.now();
    const result = await client.systemOne({
      state,
      questions: { selection: choice(NEXT_STEP_QUESTION, offered) },
    });
    const answer = result.answers.selection;
    const probabilities = answer?.probabilities;
    if (
      !answer || !variant.optionIds.includes(answer.choice) ||
      !probabilities || typeof probabilities !== 'object' ||
      Object.keys(probabilities).some((id) => !variant.optionIds.includes(id)) ||
      variant.optionIds.some((id) =>
        typeof probabilities[id] !== 'number' || !Number.isFinite(probabilities[id]) ||
        probabilities[id]! < 0 || probabilities[id]! > 1,
      ) ||
      Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) > 0.01
    ) {
      throw new Error(`Unusable distribution for ${variant.label}; no measurement fabricated.`);
    }
    const baseline = measurements[0];
    const measurement: Measurement = {
      ...variant,
      measuredAt: new Date().toISOString(),
      model: result.model,
      latencyMs: Math.round(performance.now() - started),
      choice: answer.choice,
      probabilities,
      deltasFromBaseline: Object.fromEntries(
        variant.optionIds
          .filter((id) => baseline && id in baseline.probabilities)
          .map((id) => [id, probabilities[id]! - baseline!.probabilities[id]!]),
      ),
    };
    measurements.push(measurement);
    report(measurement);
    return measurement;
  }

  const baseline = await measure({ label: 'baseline', optionIds: ids });
  const dropped = ids
    .filter((id) => id !== baseline.choice && id !== NONE_OF_THESE)
    .sort((a, b) => baseline.probabilities[a]! - baseline.probabilities[b]!)[0];
  if (!dropped) throw new Error('No unselected action is available to remove.');
  for (const variant of perturbationsOf(ids, SPURIOUS, dropped).slice(1)) {
    await measure(variant);
  }
  return measurements;
}

async function main(): Promise<void> {
  if (!isLiveJev()) {
    throw new Error('Candidate-set perturbation requires live Jev. Unset JEV_MOCK and set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN (or JEV_BACKEND=local for the Laya proxy, not Jev).');
  }
  const scenario = SCENARIOS[0];
  if (!scenario) throw new Error('The example 07 seed scenario is missing.');
  const context = {
    snapshot: createAuthority(seed()).read(),
    principal: scenario.principal,
    cardId: CARD_IN_SCOPE,
    sources: scenario.sources,
    completed: [],
    evidence: [],
  };
  console.log(JSON.stringify({
    instrument: 'candidate-set-perturbation',
    mode: runMode(true),
    scenario: scenario.id,
    sdkVersion: VERSION,
    question: NEXT_STEP_QUESTION,
    limitation: 'Synthetic state, four live requests, no action execution or accuracy claim. Raw mass deltas include normalization effects.',
  }));
  const { client } = createClient();
  await measurePerturbations(
    client,
    buildState(context),
    nextStepCriteria(computeEligibility(context)),
    (measurement) => console.log(JSON.stringify(measurement)),
  );
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
