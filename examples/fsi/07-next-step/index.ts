/**
 * 07 — Bounded next-step recommendation.
 *
 * ## The claim this example is allowed to make
 *
 * Deterministic code constructs the eligible option set before the Jev request;
 * ineligible actions are never supplied as options; the application applies an
 * explicit abstention and escalation policy to the returned distribution;
 * argument binding is step-specific and accepts only authoritative record
 * identifiers or exact permitted source spans; consequential actions require a
 * named approval bound to an immutable proposal digest and revalidated against
 * fresh state; and the ledger records the difference between what Jev
 * recommended and what the application executed.
 *
 * ## The claims this example is NOT allowed to make
 *
 * That Jev understands fraud reports. That it is calibrated for banking workflow
 * selection. That it prevents hallucination. That it provides authorization or
 * makes any action safe. That bounded options imply a correct or harmless
 * choice. That this pattern safely automates card freezes or dispute filing, or
 * reduces fraud loss, handling time or clarification turns. That anything here
 * demonstrates live API behaviour, latency, cost or reliability. That human
 * confirmation by itself satisfies a regulatory, authorization or operational
 * requirement.
 *
 * The full contract is `docs/CLAIM-CONTRACTS.md`; the limits of the pattern are
 * `docs/FSI-BOUNDARIES.md`.
 *
 * ## What is scripted
 *
 * Everything the model does. `src/mock-fetch.ts` manufactures the selected
 * option *and the shape of the distribution* for all six fixtures. So a run
 * shows what the application does with a distribution, and cannot show that a
 * distribution deserves trust.
 *
 * Run:  npm run fsi:07
 */

import { VERSION } from '@typesafe-ai/sdk';
import type { Authority, AuthorityState } from '../../../src/authority.ts';
import { createAuthority, formatAmount } from '../../../src/authority.ts';
import { createClient } from '../../../src/client.ts';
import { fixtureBanner, runMode } from '../../../src/fixture-label.ts';
import type { DistributionMetrics } from '../../../src/ledger.ts';
import { createLedger, metricsFor, stateReference, summarize } from '../../../src/ledger.ts';
import type { MockScript, ScriptedAnswer } from '../../../src/mock-fetch.ts';
import { bold, cyan, dim, green, red, title, yellow } from '../../../src/ui.ts';
import type {
  BoundValue,
  StepSpec,
  WorkflowContext,
} from '../../../src/workflow-machine.ts';
import {
  bindArguments,
  candidatesFor,
  computeEligibility,
  deterministicArguments,
  NONE_OF_THESE,
  plainArguments,
  slotsNeedingSelection,
  stepById,
} from '../../../src/workflow-machine.ts';
import { baselineCandidate, baselineNextStep } from './baseline.ts';
import { buildProposal, digestOf, revalidate } from './approval.ts';
import type { Approval } from './approval.ts';
import { createControlArm } from './control-arm.ts';
import { decide, HUMAN_QUEUE, POLICY_VERSION, thresholdRecord } from './policy.ts';
import { buildState, FIELDS_WITHHELD, recommendNextStep, selectCandidate } from './recommend.ts';
import {
  printBound,
  printDistribution,
  printEligibility,
  printRejections,
  printRoute,
  printSummary,
} from './report.ts';
import type { SummaryRow } from './report.ts';
import { CARD_IN_SCOPE, SCENARIOS, seed } from './scenarios.ts';
import type { Scenario } from './scenarios.ts';

const { live } = createClient();

fixtureBanner(live);
title('07 — Bounded next-step recommendation');
console.log(
  dim(
    'Deterministic code reads the records, decides what is even eligible, and only\n' +
      'then asks Jev which eligible step comes next. Every safety property below is\n' +
      'owned by code; the baseline column shows the same workflow with Jev removed.',
  ),
);

const ledger = createLedger({
  component: 'fsi-07-next-step',
  mode: runMode(live),
  service: { model: 'jev-latest', sdkPackage: '@typesafe-ai/sdk', sdkVersion: VERSION },
  ...(process.env['JEV_LEDGER_FILE'] ? { file: process.env['JEV_LEDGER_FILE'] } : {}),
});

/** Turns a scripted answer into a mock transport for one `systemOne` call. */
function script(answer: ScriptedAnswer | 'throw' | undefined): MockScript | undefined {
  if (answer === undefined) return undefined;
  if (answer === 'throw') {
    return () => {
      throw new Error('socket hang up');
    };
  }
  return () => ({ selection: answer });
}

function contextFor(authority: Authority, scenario: Scenario): WorkflowContext {
  return {
    snapshot: authority.read(),
    principal: scenario.principal,
    cardId: CARD_IN_SCOPE,
    sources: scenario.sources,
    completed: [],
  };
}

/**
 * The only function in this example that changes anything.
 *
 * It runs after binding, after approval and after revalidation, and it is handed
 * already-bound arguments rather than raw strings.
 */
function execute(
  step: StepSpec,
  bound: Readonly<Record<string, BoundValue>>,
  authority: Authority,
): string {
  const args = plainArguments(bound);

  switch (step.id) {
    case 'freeze_card': {
      authority.applyOutOfBandChange('harness froze the card', (state: AuthorityState) => {
        state.cards = state.cards.map((card) =>
          card.cardId === args['cardId'] ? { ...card, status: 'frozen' } : card,
        );
      });
      return `authorizations blocked on ${args['cardId']}`;
    }
    case 'open_dispute': {
      const amount = Number(args['amountMinor'] ?? 0);
      authority.applyOutOfBandChange('harness opened a dispute', (state: AuthorityState) => {
        state.transactions = state.transactions.map((entry) =>
          entry.transactionId === args['transactionId']
            ? { ...entry, disputeId: 'DSP-40012' }
            : entry,
        );
      });
      return `dispute DSP-40012 raised on ${args['transactionId']} for ${formatAmount(amount, 'GBP')}`;
    }
    case 'send_transaction_receipt':
      return `detail for ${args['transactionId']} sent to the customer`;
    case 'schedule_callback':
      return `callback booked in ${args['slotId']}`;
    case 'record_customer_note':
      return 'message attached to the case, tagged untrusted';
    case 'order_replacement_card':
      return `replacement ordered for ${args['cardId']}`;
    case 'close_case':
      return `${args['caseId']} closed`;
  }
}

const rows: SummaryRow[] = [];

for (const scenario of SCENARIOS) {
  title(`${scenario.id} — ${scenario.title}`);
  console.log(`  ${dim(scenario.demonstrates)}`);
  console.log(`  ${dim(`fixture label: ${scenario.label}`)}`);

  const authority = createAuthority(seed());
  if (scenario.interruption?.when === 'before_recommendation') {
    authority.applyOutOfBandChange(scenario.interruption.note, scenario.interruption.change);
    console.log(`  ${yellow('records moved')} ${dim(scenario.interruption.note)}`);
  }

  const context = contextFor(authority, scenario);
  const eligibility = computeEligibility(context);
  printEligibility(eligibility);

  // ---------------------------------------------------------------------
  // The baseline arm: same eligibility, no model.
  // ---------------------------------------------------------------------
  const baseline = baselineNextStep(eligibility);
  const baselineLabel = baseline.step?.id ?? '(no eligible step)';

  // ---------------------------------------------------------------------
  // The adversarial control-arm fixture, where the scenario has one.
  // ---------------------------------------------------------------------
  if (scenario.controlArm) {
    const arm = createControlArm(scenario.controlArm);
    const proposed = await arm.propose(buildState(context));
    const armStep = stepById(proposed.stepId);
    console.log(
      `\n  ${bold('control arm')} ${dim(`${arm.modelId} · schema-valid, records unchecked`)}`,
    );
    if (armStep) {
      const armBinding = bindArguments(armStep, proposed.arguments, context);
      if (armBinding.ok) {
        console.log(`  ${yellow('bound')} ${dim('unexpectedly — the fixture no longer demonstrates its point')}`);
      } else {
        printRejections('generative proposal', armBinding.rejections);
        console.log(
          `  ${dim(
            'Rejected by bindArguments, the same function the Jev arm below goes through.\n' +
              '  This is an adversarial fixture, not a fair benchmark: a competent generative\n' +
              '  implementation can be constrained to enumerated record IDs and would pass the\n' +
              '  same checks, for the same reason — the checks are in the application.',
          )}`,
        );
      }
      ledger.record({
        state: stateReference(buildState(context), FIELDS_WITHHELD),
        candidates: {
          source: eligibility.source,
          version: eligibility.version,
          optionIds: eligibility.eligible.map((step) => step.id),
          readAt: eligibility.readAt,
        },
        policy: {
          policyVersion: POLICY_VERSION,
          thresholds: thresholdRecord(),
          route: 'refused',
          reason:
            'adversarial control-arm fixture: proposed arguments did not bind to records. ' +
            'Executed action is in the harness namespace, not the option namespace.',
        },
        executed: { action: HUMAN_QUEUE, divergedFromRecommendation: true },
        latencyMs: 0,
      });
    }
    console.log('');
  }

  // ---------------------------------------------------------------------
  // Stage one: which eligible step comes next.
  // ---------------------------------------------------------------------
  const { value: recommendation, latencyMs } = await ledger.timed(() =>
    recommendNextStep(eligibility, context, script(scenario.stepAnswer)),
  );

  let metrics: DistributionMetrics | null = null;
  if (recommendation.probabilities && recommendation.choice) {
    metrics = metricsFor(
      recommendation.probabilities,
      recommendation.choice,
      recommendation.optionIds,
    );
  }

  const chosenStep =
    recommendation.choice && recommendation.choice !== NONE_OF_THESE
      ? (eligibility.eligible.find((step) => step.id === recommendation.choice) ?? null)
      : null;

  if (recommendation.failure) {
    console.log(`  ${red('service')} ${dim(recommendation.failure)}`);
  } else {
    console.log(`\n  ${bold('jev recommends')} ${cyan(recommendation.choice ?? '(nothing)')}`);
    printDistribution(recommendation.probabilities, metrics);
  }

  const policy = decide({
    metrics,
    choice: recommendation.choice,
    step: chosenStep,
    failure: recommendation.failure,
  });
  printRoute(policy);

  const candidateProvenance = {
    source: eligibility.source,
    version: eligibility.version,
    optionIds: recommendation.optionIds,
    readAt: eligibility.readAt,
  };
  const recommendationRecord = recommendation.choice
    ? {
        question: recommendation.question,
        choice: recommendation.choice,
        ...(recommendation.probabilities ? { probabilities: recommendation.probabilities } : {}),
        ...(recommendation.confidence !== null ? { confidence: recommendation.confidence } : {}),
      }
    : null;

  /** Records the decision and closes out the scenario. */
  function close(action: string, args?: Record<string, string>, note?: string): void {
    if (note) console.log(`  ${dim(note)}`);
    ledger.record({
      state: stateReference(buildState(context), FIELDS_WITHHELD),
      candidates: candidateProvenance,
      recommendation: recommendationRecord,
      metrics,
      policy: {
        policyVersion: POLICY_VERSION,
        thresholds: thresholdRecord(),
        route: policy.route,
        reason: policy.reason,
      },
      executed: { action, ...(args ? { arguments: args } : {}) },
      ...(recommendation.failure
        ? {
            failure: {
              kind: 'service_error' as const,
              detail: recommendation.failure,
              fallback: `routed to ${HUMAN_QUEUE}`,
            },
          }
        : {}),
      latencyMs,
    });
    rows.push({
      scenario: scenario.id,
      recommended: recommendation.choice ?? '(none)',
      route: policy.route,
      executed: action,
      baseline: baselineLabel,
    });
  }

  if (policy.route === 'refused' || policy.route === 'escalated' || chosenStep === null) {
    close(policy.action, undefined, `nothing executed; case routed to ${HUMAN_QUEUE}`);
    console.log(`  ${dim(`baseline arm would have taken: ${baselineLabel}`)}`);
    continue;
  }

  // ---------------------------------------------------------------------
  // Stage two: bind arguments, step-specifically.
  // ---------------------------------------------------------------------
  const proposedArguments: Record<string, string> = deterministicArguments(chosenStep, context);
  const open = slotsNeedingSelection(chosenStep, context);
  let abandoned = false;

  for (const slot of open) {
    const candidates = candidatesFor(chosenStep, slot, context);
    console.log(
      `\n  ${bold('stage two')} ${dim(`${slot.name}: ${candidates.length} candidate ${slot.recordType}(s) from the records`)}`,
    );
    const selection = await selectCandidate(
      candidates,
      slot.description,
      context,
      script(scenario.argumentAnswer),
    );
    if (selection.choice === null || selection.choice === NONE_OF_THESE) {
      close(HUMAN_QUEUE, undefined, 'no candidate record selected; escalating');
      abandoned = true;
      break;
    }
    console.log(`    ${dim(`selected ${selection.choice}`)}`);
    proposedArguments[slot.name] = selection.choice;
  }

  if (abandoned) continue;

  const binding = bindArguments(chosenStep, proposedArguments, context);
  if (!binding.ok) {
    printRejections('jev-selected proposal', binding.rejections);
    close(HUMAN_QUEUE, undefined, 'nothing executed');
    continue;
  }
  console.log(`\n  ${bold('bound arguments')}`);
  printBound(binding.bound);

  // ---------------------------------------------------------------------
  // Approval, then revalidation against a fresh read.
  // ---------------------------------------------------------------------
  const proposal = buildProposal(ledger.runId, chosenStep, binding.bound, context);
  const digest = digestOf(proposal);

  if (!chosenStep.consequential) {
    const effect = execute(chosenStep, binding.bound, authority);
    close(chosenStep.id, plainArguments(binding.bound), `${green('EXECUTED')} ${effect}`);
    console.log(`  ${dim(`baseline arm would have taken: ${baselineLabel}`)}`);
    continue;
  }

  const approval: Approval = {
    digest,
    principal: scenario.principal,
    decision: scenario.approval ?? 'declined',
    at: context.snapshot.readAt,
  };
  console.log(
    `\n  ${bold('approval')} ${dim(`${approval.principal.role} ${approval.decision} proposal ${digest}`)}`,
  );

  if (scenario.interruption?.when === 'after_approval') {
    authority.applyOutOfBandChange(scenario.interruption.note, scenario.interruption.change);
    console.log(`  ${yellow('records moved')} ${dim(scenario.interruption.note)}`);
  }

  // A fresh read, not the snapshot the proposal was built on.
  const fresh = contextFor(authority, scenario);
  const revalidated = revalidate({ proposal, approval, step: chosenStep, fresh });

  if (!revalidated.ok) {
    console.log(`  ${red('HELD')} ${dim(revalidated.reason)}`);
    close(HUMAN_QUEUE, undefined, 'approval not honoured; nothing executed');
    console.log(`  ${dim(`baseline arm would have taken: ${baselineLabel}`)}`);
    continue;
  }
  if (revalidated.note) console.log(`  ${dim(revalidated.note)}`);

  const effect = execute(chosenStep, revalidated.bound, authority);
  close(chosenStep.id, plainArguments(revalidated.bound), `${green('EXECUTED')} ${effect}`);
  console.log(`  ${dim(`baseline arm would have taken: ${baselineLabel}`)}`);
}

// ---------------------------------------------------------------------------
title('Recommended vs executed');
printSummary(rows);
console.log(
  `\n  ${dim('Rows where `harness executed` differs from `jev recommended` are the')}\n` +
    `  ${dim('interesting ones. The ledger stores both, separately, and derives the difference.')}`,
);

title('Where the safety properties live');
console.log(
  dim(
    'ineligible action cannot be selected   computeEligibility()   deterministic\n' +
      'principal cannot exceed entitlement    permits()              deterministic\n' +
      'argument must resolve to a record      bindArguments()        deterministic\n' +
      'narrative must be the customer’s words resolveSpan()          deterministic\n' +
      'consequential action needs approval    STEPS[].consequential  deterministic\n' +
      'approval binds to one frozen proposal  digestOf()             deterministic\n' +
      'state cannot go stale under approval   revalidate()           deterministic\n' +
      'which eligible step to try first       Jev                    unmeasured\n' +
      'when the case is too unclear to act    Jev + policy           unmeasured',
  ),
);
console.log(
  `\n  ${dim('The baseline column ran the whole workflow with Jev removed and static')}\n` +
    `  ${dim('priority in its place. It refuses everything this run refused. What it')}\n` +
    `  ${dim('cannot do is abstain — static priority always has an answer, which is why')}\n` +
    `  ${dim('it would have frozen a card on the ambiguous report. Whether preselection')}\n` +
    `  ${dim('or abstention is worth anything here is not measured by this repository.')}`,
);

title('Ledger');
for (const entry of ledger.entries()) console.log(`  ${summarize(entry)}`);
console.log(
  `\n  ${dim(`${ledger.entries().length} records, mode ${runMode(live)}. Set JEV_LEDGER_FILE to write JSONL.`)}\n` +
    `  ${dim('Evidence capture that may support governance. Not an audit trail: not')}\n` +
    `  ${dim('tamper-evident, not immutable, not independently verified, and a hashed')}\n` +
    `  ${dim('state reference is not anonymization.')}`,
);
