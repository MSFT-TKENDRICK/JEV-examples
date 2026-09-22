/**
 * 01 — Quickstart: all three primitives in one request.
 *
 * The single most important habit with Jev: ask every question you might need
 * in ONE call. Questions are evaluated in parallel and in isolation against the
 * same state, so a fourth question costs almost no extra latency and cannot
 * pollute the other three with context rot.
 *
 * Run:  node examples/01-quickstart.ts
 */

import { confidenceOf, evaluate } from '../src/jev.ts';
import { transportForExample } from '../src/mock.ts';
import { rankedOptions, selectedProbability } from '../src/rubric.ts';
import { banner, bars, bold, cyan, dim, pct, title } from '../src/ui.ts';

const ticket = {
  subject: 'Charged twice for the annual plan',
  body:
    "I've been trying to connect my Stripe account for 3 days and the integration " +
    'keeps failing. On top of that I was billed twice for the annual plan. ' +
    "I'm losing sales every hour this is broken. Please refund the duplicate and " +
    'tell me what is going on.',
  plan: 'annual',
  accountAgeDays: 412,
};

// Each question is one snap judgment. Anything that would need multi-step
// reasoning gets decomposed into separate questions and recombined in code.
const questions = {
  department: {
    type: 'choice',
    instructions: 'Which team should handle this ticket?',
    criteria: {
      billing: 'Charges, invoices, refunds and subscription changes',
      technical: 'Bugs, outages and integration failures',
      sales: 'Pricing, upgrades and new accounts',
      other: null,
    },
  },
  severity: {
    type: 'score',
    instructions: 'How severe is the impact on the customer right now?',
    criteria: [
      'Cosmetic; functionality is unaffected',
      'Degraded, but a workaround exists',
      'A core workflow is blocked',
      'Revenue-affecting outage with no workaround',
    ],
  },
  frustration: {
    type: 'score',
    instructions: 'How frustrated does the customer sound?',
    criteria: ['Calm, just stating facts', 'Frustrated but civil', 'Angry, strong language'],
  },
  requestsRefund: {
    type: 'boolean',
    instructions: 'Is the customer asking for money back?',
    criteria: {
      true: 'An explicit request for a refund, credit or chargeback',
      false: 'No mention of money being returned',
    },
  },
  mentionsChurn: {
    type: 'boolean',
    // A speculative question: cheap to ask, and useful if it fires.
    instructions: 'Does the customer hint they may cancel or leave?',
  },
} as const;

const { transport, live } = transportForExample(() => ({
  department: { choice: 'billing', strength: 0.52 },
  severity: { score: 2.7 },
  frustration: { score: 1.2 },
  requestsRefund: { probability: 0.97 },
  mentionsChurn: { probability: 0.31 },
}));

title('01 — One request, five questions');
banner(live);

const started = Date.now();
const result = await evaluate({ state: ticket, questions, ...(transport && { transport }) });
const elapsed = Date.now() - started;

const { department, severity, frustration, requestsRefund, mentionsChurn } = result.answers;

console.log(`\n${bold('Choice')} — department: ${cyan(department.choice)}`);
bars(department.probabilities);
console.log(
  `  ${dim(
    `selected probability ${pct(selectedProbability(department))} · ` +
      `confidence ${pct(confidenceOf(result, 'department'))}`,
  )}`,
);

console.log(`\n${bold('Score')} — severity: ${cyan(severity.score.toFixed(2))} of 3`);
bars(severity.probabilities, {
  labels: Object.fromEntries(questions.severity.criteria.map((c, i) => [String(i), `${i} ${c}`])),
});

console.log(`\n${bold('Score')} — frustration: ${cyan(frustration.score.toFixed(2))} of 2`);
bars(frustration.probabilities, {
  labels: Object.fromEntries(questions.frustration.criteria.map((c, i) => [String(i), `${i} ${c}`])),
});

console.log(`\n${bold('Boolean')} — probabilities, not verdicts`);
console.log(`  requestsRefund  ${pct(requestsRefund.probability)}`);
console.log(`  mentionsChurn   ${pct(mentionsChurn.probability)}`);

// ---------------------------------------------------------------------------
// Everything above is measurement. The policy below is ordinary code, which is
// the point: thresholds are reviewable, testable and changeable without
// touching a prompt.
// ---------------------------------------------------------------------------
title('Routing decision (plain code)');

const queue = severity.score >= 2.5 ? 'urgent' : 'standard';
const refundPath = requestsRefund.probability >= 0.8 ? 'auto-open refund case' : 'no refund case';
const escalate = frustration.score >= 1.5 || mentionsChurn.probability >= 0.5;

// Low confidence on the routing question means "ask a person", not "guess harder".
const departmentConfidence = confidenceOf(result, 'department') ?? 1;
const routed =
  departmentConfidence < 0.6
    ? `triage queue (confidence ${pct(departmentConfidence)} too low to auto-route)`
    : department.choice;

console.log(`  route to        ${cyan(routed)}`);
console.log(`  queue           ${queue}`);
console.log(`  refund          ${refundPath}`);
console.log(`  escalate to CSM ${escalate ? 'yes' : 'no'}`);

if (departmentConfidence < 0.6) {
  console.log(
    `\n  ${dim('Runner-up options, if a human wants a shortlist:')}\n  ` +
      rankedOptions(department)
        .slice(0, 3)
        .map((o) => `${o.option} ${pct(o.probability)}`)
        .join('   '),
  );
}

console.log(
  `\n${dim(
    `${Object.keys(questions).length} questions · ${elapsed}ms · ` +
      `${result.usage?.inputTokens ?? '?'} input tokens · model ${result.response.modelId}`,
  )}`,
);
