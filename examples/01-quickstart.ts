/**
 * 01 — Quickstart: all three primitives in one request, and what the answer
 * does next.
 *
 * Two habits, in order of importance.
 *
 * First: ask every question you might need in ONE call. Questions are evaluated
 * in parallel and in isolation against the same state, so a fifth question
 * costs almost no extra latency and cannot pollute the other four with context
 * rot.
 *
 * Second: when the answer comes back flat, the flatness is what picks the next
 * question. The routing distribution here is a prior; two possible follow-up
 * questions are ranked by how much entropy each is expected to remove per unit
 * of cost; the winner becomes a second request whose **option set is built from
 * the first distribution** — options no remaining contender predicts are not
 * offered at all. The observation updates the prior, and then the application
 * either routes or refuses. It does not ask a person. Refusing is a terminal
 * state: the ticket is left exactly as it was found.
 *
 * (Routing a ticket to a team is the task. What is ruled out is using a person
 * as the *answer to a flat distribution* — a triage queue, a shortlist for
 * someone to pick from, an escalation. Those resolve nothing; they relocate it.)
 *
 * What this run does and does not establish
 * -----------------------------------------
 * By default, the questions go to real Jev. Explicit `JEV_MOCK=1` runs use
 * scripted fixtures in `src/mock-fetch.ts`, which
 * manufacture HTTP responses on the published SDK's real code path. The probe
 * costs and the mapping from an observation to the departments it is consistent
 * with are **authored**; the ranking, the posterior and the routing decision are
 * computed from them. So this shows what the application does with a
 * distribution, not that the distribution deserves trust. See
 * `docs/CLAIM-CONTRACTS.md`.
 *
 * Run:  node examples/01-quickstart.ts
 */

import { choice, noul, score } from '@typesafe-ai/sdk';
import { activeBackend, backendLabel, createClient } from '../src/client.ts';
import { partitionProbe, type Probe } from '../src/information-gain.ts';
import { askChoice } from '../src/judge/ask.ts';
import { investigate, leader } from '../src/judge/investigate.ts';
import type { ScriptedAnswer } from '../src/mock-fetch.ts';
import { rankedOptions } from '../src/rubric.ts';
import {
  banner,
  bars,
  bold,
  cyan,
  dim,
  green,
  legendLabels,
  note,
  pct,
  red,
  title,
  yellow,
} from '../src/ui.ts';

const departments = {
  billing: 'Charges, invoices, refunds and subscription changes',
  technical: 'Bugs, outages and integration failures',
  sales: 'Pricing, upgrades and new accounts',
  other: null,
};

const tickets = [
  {
    id: 'double-charge',
    subject: 'Charged twice for the annual plan',
    body:
      "I've been trying to connect my Stripe account for 3 days and the integration " +
      'keeps failing. On top of that I was billed twice for the annual plan. ' +
      "I'm losing sales every hour this is broken. Please refund the duplicate and " +
      'tell me what is going on.',
    plan: 'annual',
    accountAgeDays: 412,
  },
  {
    id: 'vague-complaint',
    subject: 'This is not working for us',
    body:
      "We've had nothing but problems since we signed up and nobody has given us a " +
      'straight answer. I need someone to sort this out or tell me what our options ' +
      'are, because right now we are paying for something we cannot use.',
    plan: 'team',
    accountAgeDays: 58,
  },
];

/**
 * Scripted answers per ticket.
 *
 * `department` uses an explicit distribution rather than a target option,
 * because the second ticket is torn between `billing` and `other` — the first
 * and last options. A peaked distribution decays with index distance and simply
 * cannot express confusion between two options that are not neighbours, which
 * is the normal case in a real option set.
 */
const scripts: Record<string, Record<string, ScriptedAnswer>> = {
  'double-charge': {
    department: { distribution: { billing: 0.42, technical: 0.4, sales: 0.06, other: 0.12 } },
    severity: { score: 2.7 },
    frustration: { score: 1.2 },
    requestsRefund: { noul: 0.97 },
    mentionsChurn: { noul: 0.31 },
    followUp: { choice: 'integration_failing', strength: 0.82 },
  },
  'vague-complaint': {
    department: { distribution: { billing: 0.34, technical: 0.16, sales: 0.08, other: 0.42 } },
    severity: { score: 1.4 },
    frustration: { score: 1.6 },
    requestsRefund: { noul: 0.24 },
    mentionsChurn: { noul: 0.61 },
    followUp: { choice: 'integration_failing', strength: 0.74 },
  },
};

/**
 * Candidate follow-up questions.
 *
 * `buckets` says which departments each answer is consistent with. Note that
 * `integration_failing` admits `other` as well as `technical`: a third-party
 * connection that stops working is sometimes the other side's problem, and
 * pretending otherwise would make the probe look sharper than it is.
 *
 * `cost` is in round trips, weighted by how much of the ticket the question
 * makes the model re-read. Both numbers are authored — what the example shows
 * is that the selection responds to them, not that they are right.
 */
interface FollowUp {
  id: string;
  cost: number;
  prompt: string;
  /** Answer label -> the criteria text offered for it. */
  options: Record<string, string>;
  /** Answer label -> the departments it is consistent with. */
  buckets: Record<string, readonly string[]>;
}

const followUps: readonly FollowUp[] = [
  {
    id: 'blocking-symptom',
    cost: 1,
    prompt: 'What is actually blocking the customer right now?',
    options: {
      charge_wrong: 'The amount charged, or the number of charges, is wrong',
      integration_failing: 'Something the customer connected has stopped working',
      unclear: 'The customer has not said clearly enough to tell',
    },
    buckets: {
      charge_wrong: ['billing'],
      integration_failing: ['technical', 'other'],
      unclear: ['sales', 'other'],
    },
  },
  {
    id: 'desired-remedy',
    cost: 1.4,
    prompt: 'What does the customer want to happen?',
    options: {
      money_back: 'Money returned to them',
      make_it_work: 'The product to start working',
      an_answer: 'Information, or a decision about their account',
    },
    buckets: {
      money_back: ['billing'],
      make_it_work: ['technical'],
      an_answer: ['sales', 'other'],
    },
  },
];

/** Options a contender holds no mass for are not offered. */
function restrict(
  followUp: FollowUp,
  contenders: readonly string[],
): { probe: Probe; options: Record<string, string> } {
  const buckets: Record<string, readonly string[]> = {};
  const options: Record<string, string> = {};

  for (const [label, departmentsFor] of Object.entries(followUp.buckets)) {
    const kept = departmentsFor.filter((department) => contenders.includes(department));
    if (kept.length === 0) continue;
    buckets[label] = kept;
    options[label] = followUp.options[label] ?? label;
  }

  return { probe: partitionProbe(followUp.id, followUp.cost, buckets, followUp.prompt), options };
}

/** A department is a contender if it holds at least this much mass. */
const CONTENDER_FLOOR = 0.15;
/** Mass the leader must hold before the ticket is routed. */
const ROUTE_AT = 0.7;
/** Probe budget, in the cost units above. Enough for one cheap follow-up. */
const PROBE_BUDGET = 1.5;

title('01 — One request, five questions');

let live = false;

for (const [index, ticket] of tickets.entries()) {
  const script = scripts[ticket.id] ?? {};
  const picked = createClient(() => script);
  live = picked.live;
  if (index === 0) banner(live);

  const started = Date.now();

  // The `choice`, `score` and `noul` builders preserve the literal types of your
  // criteria, so `department.choice` below is typed to the four labels — not to
  // `string`.
  const { answers, usage, model } = await picked.client.systemOne({
    state: ticket,
    questions: {
      // Each question is one snap judgment. Anything that would need multi-step
      // reasoning gets decomposed and recombined in code.
      department: choice('Which team should handle this ticket?', departments),
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

  title(`Ticket ${ticket.id} — ${ticket.subject}`);

  console.log(`${bold('Choice')} — department: ${cyan(department.choice)}`);
  bars(department.probabilities);

  if (index === 0) {
    // `legend` comes back on the answer, so the rubric does not have to be
    // repeated here just to label the output.
    console.log(`\n${bold('Score')} — severity: ${cyan(severity.score.toFixed(2))} of 3`);
    bars(severity.probabilities, { labels: legendLabels(severity.legend) });
    console.log(`\n${bold('Score')} — frustration: ${cyan(frustration.score.toFixed(2))} of 2`);
    bars(frustration.probabilities, { labels: legendLabels(frustration.legend) });
    console.log(`\n${bold('Noul')} — probabilities, not verdicts`);
    console.log(`  requestsRefund  ${pct(requestsRefund.noul)}`);
    console.log(`  mentionsChurn   ${pct(mentionsChurn.noul)}`);
  } else {
    console.log(
      dim(
        `\n  severity ${severity.score.toFixed(2)}/3 · frustration ${frustration.score.toFixed(2)}/2 · ` +
          `requestsRefund ${pct(requestsRefund.noul)} · mentionsChurn ${pct(mentionsChurn.noul)}`,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // The distribution picks the next question.
  // -------------------------------------------------------------------------
  const contenders = rankedOptions(department).filter(
    (option) => option.probability >= CONTENDER_FLOOR,
  );
  const contenderIds = contenders.map((option) => option.option);

  const prior = Object.fromEntries(
    contenders.map((option) => [option.option, option.probability]),
  );

  const restricted = followUps.map((followUp) => restrict(followUp, contenderIds));
  const optionsById = new Map(restricted.map(({ probe, options }) => [probe.id, options]));

  console.log(`\n${bold('The first answer chooses the second question')}`);
  console.log(
    dim(
      `  contenders (>= ${pct(CONTENDER_FLOOR)})  ${contenders
        .map((option) => `${option.option} ${pct(option.probability)}`)
        .join('   ')}`,
    ),
  );

  const investigation = await investigate(
    prior,
    restricted.map(({ probe }) => probe),
    async (probe) => {
      const options = optionsById.get(probe.id) ?? {};
      const followUp = followUps.find((candidate) => candidate.id === probe.id);
      console.log(
        `  ${cyan(probe.id)}  ${dim(followUp?.prompt ?? '')}\n` +
          dim(`    offered  ${Object.keys(options).join(', ')}`),
      );
      const answer = await askChoice(picked.client, ticket, 'followUp', choice(probe.description ?? probe.id, options));
      return answer.choice;
    },
    { decisionThreshold: ROUTE_AT, budget: PROBE_BUDGET, minimumGain: 0.05 },
  );

  for (const step of investigation.trail) {
    console.log(
      dim(
        `    ranked   ${step.ranked
          .map((r) => `${r.probeId} ${r.gainPerCost.toFixed(3)}/cost ${r.cost}`)
          .join('   ')}`,
      ),
    );
    console.log(
      dim(
        `    entropy  ${step.priorEntropy.toFixed(3)} nats → expected ` +
          `${step.expectedPosteriorEntropy.toFixed(3)}, actual ` +
          `${step.actualPosteriorEntropy.toFixed(3)}`,
      ),
    );
    console.log(
      `    observed ${cyan(step.observation)}  ${dim(
        `leader ${step.before.candidate} ${pct(step.before.mass)} → ` +
          `${step.after.candidate} ${pct(step.after.mass)}`,
      )}`,
    );
  }

  // -------------------------------------------------------------------------
  // Everything above is measurement. The policy below is ordinary code, which
  // is the point: thresholds are reviewable, testable and changeable without
  // touching a prompt.
  // -------------------------------------------------------------------------
  console.log(`\n${bold('Routing decision (plain code)')}`);

  const queue = severity.score >= 2.5 ? 'urgent' : 'standard';
  const refundPath = requestsRefund.noul >= 0.8 ? 'auto-open refund case' : 'no refund case';

  if (investigation.resolution.kind === 'resolved') {
    const routed = investigation.resolution.candidate;
    const flipped = routed !== department.choice;
    console.log(`  route to   ${cyan(routed)}  ${dim(investigation.resolution.reason)}`);
    if (flipped) {
      console.log(
        `  ${yellow('→')} ${bold(
          `the probe changed the route: argmax was ${department.choice}, routed to ${routed}`,
        )}`,
      );
    }
    console.log(`  queue      ${queue}`);
    console.log(`  refund     ${refundPath}`);
  } else {
    console.log(`  ${red('route to   nothing — refused')}`);
    console.log(`  ${dim(investigation.resolution.reason)}`);
    console.log(
      note([
        `The leader, ${investigation.resolution.leader}, holds ` +
          `${pct(investigation.resolution.mass)} against a ${pct(ROUTE_AT)} bar. The ticket is`,
        'left exactly as it was found: not assigned, not queued, not put in front of',
        'anyone to pick from. Terminal, with a stated reason.',
      ]),
    );
  }

  console.log(
    `\n${dim(
      `5 questions + ${investigation.trail.length} follow-up · ${elapsed}ms first call · ` +
        `${usage.input_tokens} input tokens · ${usage.output_tokens} output tokens · model ${model}`,
    )}`,
  );
}

console.log(
  `\n${green('✓')} ${dim(
    live
      ? `Two tickets judged by ${activeBackend() === 'local' ? 'local Laya (not Jev)' : 'Jev'}. Routes and follow-ups above use the returned answers, not the fixture scripts.`
      : 'Same code, two tickets: one where the follow-up moved the route off the first ' +
        'answer, one where the budget ran out and the application changed nothing.',
  )}`,
);
console.log(
  `${yellow('!')} ${dim(
    (live ? `Live responses from ${backendLabel()}. ` : 'Offline scripted fixtures; no Jev inference. ') +
      'Probe costs and the answer/department partitions are authored; calibration is not established.',
  )}`,
);
