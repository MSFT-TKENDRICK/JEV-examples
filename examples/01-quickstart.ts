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

import { choice, noul, score } from '@typesafe-ai/sdk';
import { createClient } from '../src/client.ts';
import { rankedOptions, selectedProbability } from '../src/rubric.ts';
import { banner, bars, bold, cyan, dim, legendLabels, pct, title } from '../src/ui.ts';

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

const { client, live } = createClient(() => ({
  department: { choice: 'billing', strength: 0.52 },
  severity: { score: 2.7 },
  frustration: { score: 1.2 },
  requestsRefund: { noul: 0.97 },
  mentionsChurn: { noul: 0.31 },
}));

title('01 — One request, five questions');
banner(live);

const started = Date.now();

// The `choice`, `score` and `noul` builders preserve the literal types of your
// criteria, so `department.choice` below is typed to the four labels — not to
// `string`.
const { answers, usage, model } = await client.systemOne({
  state: ticket,
  questions: {
    // Each question is one snap judgment. Anything that would need multi-step
    // reasoning gets decomposed and recombined in code.
    department: choice('Which team should handle this ticket?', {
      billing: 'Charges, invoices, refunds and subscription changes',
      technical: 'Bugs, outages and integration failures',
      sales: 'Pricing, upgrades and new accounts',
      other: null,
    }),
    severity: score('How severe is the impact on the customer right now?', [
      'Cosmetic; functionality is unaffected',
      'Degraded, but a workaround exists',
      'A core workflow is blocked',
      'Revenue-affecting outage with no workaround',
    ]),
    frustration: score('How frustrated does the customer sound?', [
      'Calm, just stating facts',
      'Frustrated but civil',
      'Angry, strong language',
    ]),
    requestsRefund: noul('Is the customer asking for money back?', {
      true: 'An explicit request for a refund, credit or chargeback',
      false: 'No mention of money being returned',
    }),
    // Speculative, and therefore worth asking: cheap now, impossible later.
    mentionsChurn: noul('Does the customer hint they may cancel or leave?'),
  },
});

const elapsed = Date.now() - started;
const { department, severity, frustration, requestsRefund, mentionsChurn } = answers;

console.log(`\n${bold('Choice')} — department: ${cyan(department.choice)}`);
bars(department.probabilities);
console.log(
  `  ${dim(
    `selected probability ${pct(selectedProbability(department))} · ` +
      `confidence ${pct(department.confidence)}`,
  )}`,
);

// `legend` comes back on the answer, so the rubric does not have to be repeated
// here just to label the output.
console.log(`\n${bold('Score')} — severity: ${cyan(severity.score.toFixed(2))} of 3`);
bars(severity.probabilities, { labels: legendLabels(severity.legend) });

console.log(`\n${bold('Score')} — frustration: ${cyan(frustration.score.toFixed(2))} of 2`);
bars(frustration.probabilities, { labels: legendLabels(frustration.legend) });

console.log(`\n${bold('Noul')} — probabilities, not verdicts`);
console.log(`  requestsRefund  ${pct(requestsRefund.noul)}`);
console.log(`  mentionsChurn   ${pct(mentionsChurn.noul)}`);

// ---------------------------------------------------------------------------
// Everything above is measurement. The policy below is ordinary code, which is
// the point: thresholds are reviewable, testable and changeable without
// touching a prompt.
// ---------------------------------------------------------------------------
title('Routing decision (plain code)');

const queue = severity.score >= 2.5 ? 'urgent' : 'standard';
const refundPath = requestsRefund.noul >= 0.8 ? 'auto-open refund case' : 'no refund case';
const escalate = frustration.score >= 1.5 || mentionsChurn.noul >= 0.5;

// Low confidence on the routing question means "ask a person", not "guess harder".
const routed =
  department.confidence < 0.6
    ? `triage queue (confidence ${pct(department.confidence)} too low to auto-route)`
    : department.choice;

console.log(`  route to        ${cyan(routed)}`);
console.log(`  queue           ${queue}`);
console.log(`  refund          ${refundPath}`);
console.log(`  escalate to CSM ${escalate ? 'yes' : 'no'}`);

if (department.confidence < 0.6) {
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
    `5 questions · ${elapsed}ms · ${usage.input_tokens} input tokens · ` +
      `${usage.output_tokens} output tokens · model ${model}`,
  )}`,
);
