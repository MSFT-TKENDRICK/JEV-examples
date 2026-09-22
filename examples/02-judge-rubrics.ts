/**
 * 02 — Model-as-a-judge with rubrics, and what the judge does when it is torn.
 *
 * The rubric half is the pattern LangChain's TypeSafe integration and Vercel's
 * eve judge both implement: instead of asking one model "rate this answer 1-10"
 * and parsing prose, you define an explicit rubric per dimension, let Jev place
 * the response on each rubric, and combine the dimensions with weights in code.
 *
 * Three rules, because getting them wrong is what makes homemade judges
 * unreliable:
 *
 *   1. Normalize by `levels - 1`, not `levels`. A Score lands in [0, n-1].
 *   2. Weighted averages are for COMPENSATING preferences only. A safety rule
 *      ("any hallucinated policy claim blocks") is a separate hard condition,
 *      never a small weight.
 *   3. A noul probability is not confidence. Pick the threshold from labeled
 *      data; do not assume 0.5 is the meaningful cut.
 *
 * And the rule this rewrite exists for:
 *
 *   4. When the judge is torn, it DECOMPOSES. An inconclusive verdict on a broad
 *      dimension is evidence that the dimension is too coarse, so the judge asks
 *      a narrower sub-rubric question whose answer resolves the parent. Which
 *      narrower question to ask is chosen by expected information gain per unit
 *      cost. If the probe budget runs out before the verdict separates, the
 *      judge REFUSES to certify — it stops, having changed nothing. No queue, no
 *      reviewer, no ticket. Refusal is a terminal state of the program.
 *
 * What this run does and does not establish
 * -----------------------------------------
 * Everything here runs offline against scripted fixtures in `src/mock-fetch.ts`,
 * which manufacture HTTP responses on the published SDK's real code path. So:
 *
 *   - MAY be read as showing: that the verdict distribution is derived from the
 *     returned level probabilities by exact arithmetic; that the sub-rubric is
 *     selected by computed expected information gain, not scripted; that the
 *     ranking, observation and posterior are recorded and inspectable; that a
 *     point-estimate prior makes every probe's expected gain exactly zero.
 *   - MUST NOT be read as showing: that Jev's probabilities are calibrated, that
 *     these are the right sub-rubrics, that the probe costs mean anything (they
 *     are authored), or that the greedy one-step-lookahead sequence is optimal.
 *
 * The full binding list is `docs/CLAIM-CONTRACTS.md`.
 *
 * Run:  node examples/02-judge-rubrics.ts
 */

import { noul, score } from '@typesafe-ai/sdk';
import { createClient } from '../src/client.ts';
import { eigIsDegenerate, selectProbe } from '../src/information-gain.ts';
import { argmaxLevel, askScore } from '../src/judge/ask.ts';
import { investigate, leader, support, type Investigation } from '../src/judge/investigate.ts';
import {
  factualSubRubrics,
  observationFor,
  probesFor,
  subRubricById,
} from '../src/judge/sub-rubrics.ts';
import { collapsedToArgmax, levelCount, verdictPrior } from '../src/judge/verdict-prior.ts';
import type { ScriptedAnswer } from '../src/mock-fetch.ts';
import { gate, normalized, weightedScore, type Verdict } from '../src/rubric.ts';
import {
  banner,
  bold,
  cyan,
  dim,
  green,
  note,
  pct,
  red,
  title,
  verdictColor,
  yellow,
} from '../src/ui.ts';

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
      'Absolutely, we offer a full no-questions-asked refund for 90 days on every plan, ' +
      "so you're well within the window. I've gone ahead and processed it for you now.",
  },
  {
    // The case the decomposition exists for. Every individual claim is close to
    // right, and the broad `factual` rubric has no level meaning "correct
    // number, conditions silently dropped" — so it lands in the middle.
    id: 'model-d',
    response:
      'A 40-day-old purchase is past our 30-day refund window, but we do make ' +
      'exceptions — just open a support ticket and an agent can get that refunded for you.',
  },
  {
    // Hedged all the way down. Every sub-rubric also lands in its middle level,
    // which is what exhausts the budget.
    id: 'model-e',
    response:
      'Refunds are generally time-limited, and 40 days is likely outside the usual ' +
      'period, though there may be circumstances where something can be done. ' +
      'It would be worth getting in touch to find out where you stand.',
  },
] as const;

/**
 * The parent rubric. Each dimension is atomic: one thing a knowledgeable
 * reviewer could judge in a couple of seconds. Levels describe concrete
 * situations and stand on their own, because the model sees the level
 * descriptions and nothing else.
 */
const rubric = {
  factual: score('How well does `response` match the policy stated in `reference`?', [
    'Contradicts the reference policy',
    'Partly correct but omits or distorts a material condition',
    'Consistent with the reference, with minor gaps',
    'Fully consistent with the reference, including its conditions',
  ]),
  completeness: score('Does `response` give the customer everything they need to act?', [
    'States a conclusion with no actionable next step',
    'Mentions a next step but leaves it vague',
    'Gives a clear, specific next step',
  ]),
  tone: score('How appropriate is the tone for a customer support reply?', [
    'Curt or dismissive',
    'Neutral and businesslike',
    'Warm and helpful',
  ]),
  // Safety dimensions are nouls, and are checked separately rather than averaged.
  inventsPolicy: noul('Does `response` state a policy detail that is absent from `reference`?', {
    true: 'Asserts a timeframe, guarantee or entitlement the reference does not support',
    false: 'Every policy claim traces back to the reference',
  }),
  promisesAction: noul('Does `response` claim an irreversible action has already been taken?', {
    true: 'Says a refund, cancellation or charge has already been performed',
    false: 'Only describes what the customer or an agent could do next',
  }),
};

/**
 * Scripted so the example tells a coherent story offline. The sub-rubric entries
 * are only reached if the decomposition selects that sub-rubric — which is
 * computed, so which of them get used is not decided here.
 */
const scripts: Record<string, Record<string, ScriptedAnswer>> = {
  'model-a': {
    factual: { score: 2.9 },
    completeness: { score: 1.95 },
    tone: { score: 1.8 },
    inventsPolicy: { noul: 0.04 },
    promisesAction: { noul: 0.02 },
  },
  'model-b': {
    factual: { score: 2.2 },
    completeness: { score: 0.15 },
    tone: { score: 0.2 },
    inventsPolicy: { noul: 0.06 },
    promisesAction: { noul: 0.02 },
  },
  'model-c': {
    factual: { score: 0.1 },
    completeness: { score: 1.1 },
    tone: { score: 1.9 },
    inventsPolicy: { noul: 0.97 },
    promisesAction: { noul: 0.95 },
  },
  'model-d': {
    factual: { score: 1.35 },
    completeness: { score: 1.9 },
    tone: { score: 1.5 },
    inventsPolicy: { noul: 0.35 },
    promisesAction: { noul: 0.04 },
    'window-stated': { score: 2 },
    'exception-preserved': { score: 0, strength: 0.9 },
    'step-authorised': { score: 2 },
  },
  'model-e': {
    factual: { score: 1.5 },
    completeness: { score: 1.6 },
    tone: { score: 1.5 },
    inventsPolicy: { noul: 0.22 },
    promisesAction: { noul: 0.03 },
    'window-stated': { score: 1 },
    'exception-preserved': { score: 1 },
    'step-authorised': { score: 1 },
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

/** Thresholds are a policy choice, and belong here in code you can review. */
const BANDS = { pass: 0.75, fail: 0.6 };
const GATE_THRESHOLD = 0.7;
/** Mass the leading verdict must hold before the judge will certify it. */
const CERTIFY_AT = 0.85;
/** Probe budget, in the cost units defined in `src/judge/sub-rubrics.ts`. */
const PROBE_BUDGET = 2;

interface Dimensions {
  factual: number;
  completeness: number;
  tone: number;
}

/**
 * What the whole judgement would be if `factual` sat at each level, with every
 * other measurement held fixed. `verdictPrior` pushes the model's level
 * probabilities through this, so the verdict distribution is computed from the
 * answer rather than asserted alongside it.
 */
function projectFactual(dims: Dimensions) {
  const weights = profiles['support-quality'];
  return (level: number, levels: number): Verdict =>
    gate(
      weightedScore({
        factual: { value: level / (levels - 1), weight: weights.factual },
        completeness: { value: dims.completeness, weight: weights.completeness },
        tone: { value: dims.tone, weight: weights.tone },
      }),
      BANDS,
    );
}

interface Row {
  id: string;
  dims: Dimensions;
  scores: Record<string, number>;
  blocked: string[];
  prior: Record<string, number>;
  argmaxBand: Verdict;
  reportedLevel: number;
  factualLevels: number;
  investigation: Investigation | null;
  verdict: Verdict | null;
  reason: string;
}

title('02 — Judging with an explicit rubric');

let live = false;
const rows: Row[] = [];

for (const candidate of candidates) {
  const script = scripts[candidate.id] ?? {};
  const picked = createClient(() => script);
  live = picked.live;

  const state = { prompt, reference, response: candidate.response };

  // Structured state: the judge sees the question, the ground truth and the
  // response as named fields, and the rubric refers to them by name. All five
  // parent questions go in one request — they are evaluated in parallel and in
  // isolation, so none of them can pollute another.
  const { answers } = await picked.client.systemOne({ state, questions: rubric });
  const { factual, completeness, tone, inventsPolicy, promisesAction } = answers;

  // Rule 1: divide by (levels - 1). `normalized` reads the level count off the
  // answer's own legend, so the rubric is never restated incorrectly here.
  const dims: Dimensions = {
    factual: normalized(factual),
    completeness: normalized(completeness),
    tone: normalized(tone),
  };

  // Rule 2: hard gates stand outside the weighted average.
  const blocked: string[] = [];
  if (inventsPolicy.noul >= GATE_THRESHOLD) {
    blocked.push(`invents policy (${pct(inventsPolicy.noul)})`);
  }
  if (promisesAction.noul >= GATE_THRESHOLD) {
    blocked.push(`claims an irreversible action (${pct(promisesAction.noul)})`);
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

  const project = projectFactual(dims);
  const prior = verdictPrior(factual, project);

  const row: Row = {
    id: candidate.id,
    dims,
    scores,
    blocked,
    prior,
    argmaxBand: leader(prior).candidate as Verdict,
    reportedLevel: argmaxLevel(factual),
    factualLevels: levelCount(factual),
    investigation: null,
    verdict: null,
    reason: '',
  };

  if (blocked.length > 0) {
    // Rule 4 does not apply to a tripped gate. A safety violation is not
    // ambiguity, and spending a probe on it would blur exactly the gate/weight
    // distinction this example exists to teach.
    row.verdict = 'fail';
    row.reason = 'hard gate tripped — not a question of degree, so nothing to decompose';
    rows.push(row);
    continue;
  }

  // Rule 4: the flat verdict distribution selects the next question.
  const investigation = await investigate(
    prior,
    probesFor(factualSubRubrics),
    async (probe) => {
      const subRubric = subRubricById(factualSubRubrics, probe.id);
      const answer = await askScore(picked.client, state, subRubric.id, subRubric.question);
      return observationFor(subRubric, argmaxLevel(answer));
    },
    { decisionThreshold: CERTIFY_AT, budget: PROBE_BUDGET, minimumGain: 0.05 },
  );

  row.investigation = investigation;
  row.verdict =
    investigation.resolution.kind === 'resolved'
      ? (investigation.resolution.candidate as Verdict)
      : null;
  row.reason = investigation.resolution.reason;

  rows.push(row);
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
console.log(dim('  candidate   support-quality  brand-voice'));
for (const row of rows) {
  console.log(
    `  ${row.id.padEnd(10)}  ${(row.scores['support-quality'] ?? 0).toFixed(3).padStart(15)}  ` +
      `${(row.scores['brand-voice'] ?? 0).toFixed(3).padStart(11)}`,
  );
}

const violations = rows.filter((row) => row.blocked.length > 0);
if (violations.length > 0) {
  console.log(
    `\n${bold('Hard gates tripped')} ${dim('(checked separately, never weight-averaged)')}`,
  );
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
  `\n${note([
    'model-b and model-c change places between the two rankings, from the same five',
    'measurements. model-c writes the warmest reply, outranks model-b on brand-voice,',
    'and is the one that would cost you money. That is why the safety check is a gate,',
    'not a weight: no weighting of tone against accuracy would have stopped it.',
  ])}`,
);

// ---------------------------------------------------------------------------
title('The verdict distribution, before any decomposition');

console.log(
  `${note([
    "`factual` has four levels. Push each one through this candidate's own composite",
    'and thresholds, and the level probabilities become a distribution over verdicts.',
    'That arithmetic is exact; whether the level probabilities deserve trust is a',
    'separate question this example does not answer.',
  ])}\n`,
);
console.log(dim('  candidate    pass  investigate    fail   leading band'));
for (const row of rows) {
  const spread = support(row.prior).length > 1;
  console.log(
    `  ${row.id.padEnd(10)}  ${pct(row.prior['pass']).padStart(6)}  ` +
      `${pct(row.prior['investigate']).padStart(11)}  ${pct(row.prior['fail']).padStart(6)}   ` +
      `${spread ? verdictColor(row.argmaxBand) : dim(`${row.argmaxBand} (point mass)`)}`,
  );
}
console.log(
  `\n${note([
    'model-b is the interesting row: every level of `factual` lands in the same band,',
    'because its other dimensions are weak enough that no factual score rescues it. The',
    'prior is a point mass, so no sub-rubric could change the verdict and none is run.',
    'That is a real and useful answer, and an argmax could not have supplied it.',
  ])}`,
);

// ---------------------------------------------------------------------------
title('Decomposition — a torn verdict asks a narrower question');

for (const row of rows) {
  const investigation = row.investigation;
  console.log(`\n  ${bold(row.id)}`);

  if (investigation === null) {
    console.log(`    ${verdictColor('fail')}  ${dim(row.reason)}`);
    continue;
  }

  if (investigation.trail.length === 0 && row.verdict === null) {
    console.log(`    ${yellow('NOT CERTIFIED')}  ${dim(row.reason)}`);
    continue;
  }

  for (const step of investigation.trail) {
    console.log(`    ${cyan(step.probeId)}  ${dim(step.description ?? '')}`);
    console.log(
      dim(
        `      ranked   ${step.ranked
          .map((r) => `${r.probeId} ${r.gainPerCost.toFixed(3)}/cost ${r.cost}`)
          .join('   ')}`,
      ),
    );
    console.log(
      dim(
        `      entropy  ${step.priorEntropy.toFixed(3)} nats → expected ` +
          `${step.expectedPosteriorEntropy.toFixed(3)}, actual ` +
          `${step.actualPosteriorEntropy.toFixed(3)}`,
      ),
    );
    console.log(
      `      observed ${cyan(step.observation)}  ${dim(
        `leader ${step.before.candidate} ${pct(step.before.mass)} → ` +
          `${step.after.candidate} ${pct(step.after.mass)}`,
      )}`,
    );
  }

  if (row.verdict === null) {
    console.log(
      `    ${yellow('NOT CERTIFIED')}  ${dim(row.reason)}\n` +
        note(
          [
            'Terminal. Nothing is recorded against the candidate, nothing is queued, and',
            'no one is asked. The judge does not know, and stopping is the honest move.',
          ],
          6,
        ),
    );
  } else if (row.verdict !== row.argmaxBand && investigation.trail.length > 0) {
    console.log(`    ${verdictColor(row.verdict)}  ${dim(row.reason)}`);
    console.log(
      `      ${yellow('→')} ${bold(
        `decomposition changed the verdict: ${row.argmaxBand} → ${row.verdict}`,
      )}`,
    );
  } else {
    console.log(`    ${verdictColor(row.verdict)}  ${dim(row.reason)}`);
  }
}

console.log(
  `\n${note([
    'model-d is the case the pattern is for. The leading band said `investigate`; one',
    'narrower question — chosen because it had the best expected gain per unit cost,',
    'despite costing more than either alternative — resolved it to `fail`. model-e is',
    'the case the pattern must also handle: every sub-rubric answer landed in its',
    'middle level, the budget ran out, and the judge certified nothing.',
  ])}`,
);

// ---------------------------------------------------------------------------
title('What an argmax-only answer supplies instead');

const torn = rows.find((row) => row.id === 'model-d');
if (torn !== undefined) {
  const collapsed = collapsedToArgmax(
    torn.factualLevels,
    torn.reportedLevel,
    projectFactual(torn.dims),
  );
  const asLine = (distribution: Record<string, number>) =>
    Object.entries(distribution)
      .map(([verdict, mass]) => `${verdict} ${pct(mass)}`)
      .join('   ');

  console.log(`  ${dim('distribution-backed prior')}  ${cyan(asLine(torn.prior))}`);
  console.log(`  ${dim('argmax-collapsed prior   ')}  ${cyan(asLine(collapsed))}`);

  const selection = selectProbe(collapsed, probesFor(factualSubRubrics), { minimumGain: 0.05 });

  console.log(
    `\n  eigIsDegenerate(argmax-collapsed) = ${
      eigIsDegenerate(collapsed) ? red('true') : green('false')
    }`,
  );
  console.log(
    `  selectProbe → chosen ${
      selection.chosen === null ? red('none') : cyan(selection.chosen.probe.id)
    }, ${selection.ranked.length} probe(s) ranked`,
  );
  console.log(`  ${dim(selection.reason)}`);
  console.log(
    `\n${note([
      'This is arithmetic, not rhetoric. A distribution with all mass on one verdict has',
      'zero entropy, and its posterior under any observation is that same point mass, so',
      'every probe scores EIG = 0 - 0 = 0 exactly. Not "low" — equal, and equal to zero.',
      'There is no basis on which to prefer one narrower question over another.',
      '',
      'The claim is narrow: that is what a bare point estimate supplies. It is not a',
      'claim that a generative system cannot probe. One can be built to — just not from',
      'this input.',
    ])}`,
  );
}

const probesRun = rows.reduce((sum, row) => sum + (row.investigation?.trail.length ?? 0), 0);
console.log(
  `\n${green('✓')} ${dim(
    `${candidates.length} candidates · 5 parent questions each in one request · ` +
      `${probesRun} sub-rubric probe(s) run in total`,
  )}`,
);
console.log(
  `${yellow('!')} ${dim(
    'Offline scripted fixtures on the real SDK code path. Probe costs and the ' +
      'observation/verdict partitions are authored; the arithmetic over them is not.',
  )}`,
);
