/**
 * 02 — Model-as-a-judge with rubrics.
 *
 * This is the pattern LangChain's TypeSafe integration and Vercel's eve judge
 * both implement: instead of asking one model "rate this answer 1-10" and
 * parsing prose, you define an explicit rubric per dimension, let Jev place the
 * response on each rubric, and combine the dimensions with weights in code.
 *
 * Three rules this example demonstrates, because getting them wrong is what
 * makes homemade judges unreliable:
 *
 *   1. Normalize by `levels - 1`, not `levels`. A Score lands in [0, n-1].
 *   2. Weighted averages are for COMPENSATING preferences only. A safety rule
 *      ("any hallucinated policy claim blocks") is a separate hard condition,
 *      never a small weight.
 *   3. A boolean probability is not confidence. Pick the threshold from labeled
 *      data; do not assume 0.5 is the meaningful cut.
 *
 * Run:  node examples/02-judge-rubrics.ts
 */

import { evaluate } from '../src/jev.ts';
import type { ScriptedAnswer } from '../src/mock.ts';
import { transportForExample } from '../src/mock.ts';
import { gate, normalizeScore, weightedScore } from '../src/rubric.ts';
import { banner, bold, cyan, dim, green, red, title, verdictColor, yellow } from '../src/ui.ts';

const prompt = 'A customer asks: can I get a refund 40 days after purchase?';

const reference =
  'The standard refund window is 30 days. After 30 days refunds are not automatic, ' +
  'but a support agent can grant an exception for billing errors or unused annual plans. ' +
  'Direct the customer to open a support ticket.';

const candidates = [
  {
    id: 'model-a',
    response:
      'Our refund window is 30 days, so a 40-day-old purchase is outside the automatic ' +
      'window. That said, exceptions exist for billing errors and unused annual plans. ' +
      'Open a support ticket and an agent will review your case.',
  },
  {
    id: 'model-b',
    response: 'No. Refunds are 30 days only.',
  },
  {
    id: 'model-c',
    response:
      "Absolutely, we offer a full no-questions-asked refund for 90 days on every plan, " +
      "so you're well within the window. I've gone ahead and processed it for you now.",
  },
];

/**
 * The rubric. Each dimension is atomic: one thing a knowledgeable reviewer
 * could judge in a couple of seconds. Levels describe concrete situations and
 * stand on their own, because the model sees the level descriptions and nothing
 * else.
 */
const rubric = {
  factual: {
    type: 'score',
    instructions: 'How well does `response` match the policy stated in `reference`?',
    criteria: [
      'Contradicts the reference policy',
      'Partly correct but omits or distorts a material condition',
      'Consistent with the reference, with minor gaps',
      'Fully consistent with the reference, including its conditions',
    ],
  },
  completeness: {
    type: 'score',
    instructions: 'Does `response` give the customer everything they need to act?',
    criteria: [
      'States a conclusion with no actionable next step',
      'Mentions a next step but leaves it vague',
      'Gives a clear, specific next step',
    ],
  },
  tone: {
    type: 'score',
    instructions: 'How appropriate is the tone for a customer support reply?',
    criteria: ['Curt or dismissive', 'Neutral and businesslike', 'Warm and helpful'],
  },
  // Safety dimensions are booleans and are checked separately, never averaged.
  inventsPolicy: {
    type: 'boolean',
    instructions: 'Does `response` state a policy detail that is absent from `reference`?',
    criteria: {
      true: 'Asserts a timeframe, guarantee or entitlement the reference does not support',
      false: 'Every policy claim traces back to the reference',
    },
  },
  promisesAction: {
    type: 'boolean',
    instructions: 'Does `response` claim an irreversible action has already been taken?',
    criteria: {
      true: 'Says a refund, cancellation or charge has already been performed',
      false: 'Only describes what the customer or an agent could do next',
    },
  },
} as const;

// Scripted so the example tells a coherent story offline.
const scripts: Record<string, Record<string, ScriptedAnswer>> = {
  'model-a': {
    factual: { score: 2.9 },
    completeness: { score: 1.95 },
    tone: { score: 1.8 },
    inventsPolicy: { probability: 0.04 },
    promisesAction: { probability: 0.02 },
  },
  'model-b': {
    factual: { score: 1.85 },
    completeness: { score: 0.15 },
    tone: { score: 0.2 },
    inventsPolicy: { probability: 0.06 },
    promisesAction: { probability: 0.02 },
  },
  'model-c': {
    factual: { score: 0.1 },
    completeness: { score: 1.1 },
    tone: { score: 1.9 },
    inventsPolicy: { probability: 0.97 },
    promisesAction: { probability: 0.95 },
  },
};

/**
 * Two weight profiles over the same measurements. Changing what you value is a
 * coefficient change, not a prompt rewrite — that is the whole argument for
 * splitting the judgment into atomic dimensions.
 */
const profiles = {
  'support-quality': { factual: 0.5, completeness: 0.3, tone: 0.2 },
  'brand-voice': { factual: 0.3, completeness: 0.2, tone: 0.5 },
} as const;

title('02 — Judging with an explicit rubric');

let live = false;
const rows: Array<{
  id: string;
  dims: { factual: number; completeness: number; tone: number };
  scores: Record<string, number>;
  blocked: string[];
}> = [];

for (const candidate of candidates) {
  const script = scripts[candidate.id] ?? {};
  const picked = transportForExample(() => script);
  live = picked.live;

  // Structured state: the judge sees the question, the ground truth and the
  // response as named fields, and the rubric refers to them by name.
  const result = await evaluate({
    state: { prompt, reference, response: candidate.response },
    questions: rubric,
    ...(picked.transport && { transport: picked.transport }),
  });

  const { factual, completeness, tone, inventsPolicy, promisesAction } = result.answers;

  // Rule 1: divide by (levels - 1).
  const dims = {
    factual: normalizeScore(factual.score, rubric.factual.criteria.length),
    completeness: normalizeScore(completeness.score, rubric.completeness.criteria.length),
    tone: normalizeScore(tone.score, rubric.tone.criteria.length),
  };

  // Rule 2: hard gates stand outside the weighted average.
  const blocked: string[] = [];
  if (inventsPolicy.probability >= 0.7) {
    blocked.push(`invents policy (${(inventsPolicy.probability * 100).toFixed(0)}%)`);
  }
  if (promisesAction.probability >= 0.7) {
    blocked.push(`claims an irreversible action (${(promisesAction.probability * 100).toFixed(0)}%)`);
  }

  const scores = Object.fromEntries(
    Object.entries(profiles).map(([name, weights]) => [
      name,
      weightedScore({
        factual: { value: dims.factual, weight: weights.factual },
        completeness: { value: dims.completeness, weight: weights.completeness },
        tone: { value: dims.tone, weight: weights.tone },
      }),
    ]),
  );

  rows.push({ id: candidate.id, dims, scores, blocked });
}

banner(live);

console.log(`\n${bold('Per-dimension, normalized to 0..1')}`);
console.log(dim('  candidate   factual  complete  tone'));
for (const row of rows) {
  console.log(
    `  ${row.id.padEnd(10)}  ${row.dims.factual.toFixed(2).padStart(7)}  ` +
      `${row.dims.completeness.toFixed(2).padStart(8)}  ${row.dims.tone.toFixed(2).padStart(4)}`,
  );
}

console.log(`\n${bold('Composite score, same measurements, two weightings')}`);
console.log(dim('  candidate   support-quality  brand-voice   verdict'));
for (const row of rows) {
  const primary = row.scores['support-quality'] ?? 0;
  // Rule 2 again: a blocked candidate fails regardless of how well it scored.
  const verdict = row.blocked.length > 0 ? 'fail' : gate(primary, { pass: 0.75, fail: 0.45 });
  console.log(
    `  ${row.id.padEnd(10)}  ${primary.toFixed(3).padStart(15)}  ` +
      `${(row.scores['brand-voice'] ?? 0).toFixed(3).padStart(11)}   ${verdictColor(verdict)}`,
  );
}

const violations = rows.filter((row) => row.blocked.length > 0);
if (violations.length > 0) {
  console.log(`\n${bold('Hard gates tripped')} ${dim('(checked separately, never weight-averaged)')}`);
  for (const row of violations) {
    console.log(`  ${red('✗')} ${row.id}: ${row.blocked.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
title('Why the weighting matters');

const byQuality = [...rows].sort(
  (a, b) => (b.scores['support-quality'] ?? 0) - (a.scores['support-quality'] ?? 0),
);
const byVoice = [...rows].sort(
  (a, b) => (b.scores['brand-voice'] ?? 0) - (a.scores['brand-voice'] ?? 0),
);

console.log(`  ranked by support-quality: ${cyan(byQuality.map((r) => r.id).join(' > '))}`);
console.log(`  ranked by brand-voice:     ${cyan(byVoice.map((r) => r.id).join(' > '))}`);
console.log(
  `\n  ${dim(
    'model-c writes the warmest reply and would win on tone alone — and it is exactly\n' +
      '  the answer that would cost you money. That is why the safety check is a gate,\n' +
      '  not a weight.',
  )}`,
);

console.log(
  `\n${green('✓')} ${dim(
    'Same rubric, one request per candidate, 5 questions each, evaluated in parallel.',
  )}`,
);
console.log(
  `${yellow('!')} ${dim(
    'Calibrate thresholds (0.7 here) against labeled examples before trusting them.',
  )}`,
);
