/**
 * 07 — Uncertainty selects the next machine action.
 *
 * ## The claim this example is allowed to make
 *
 * Deterministic code constructs the eligible option set before the Jev request;
 * ineligible actions are never supplied as options; when the returned
 * distribution is flat the application selects a read-only probe by expected
 * information gain per unit cost, performs that read, and judges again with the
 * observation in the state; when the distribution concentrates, the selected
 * step is expanded into an act/verify/compensate plan in which every reversible
 * step is verified before the single irreversible step runs, and a failed
 * verification compensates in reverse order; when the probe budget is exhausted
 * without concentration the application refuses, terminally, having changed
 * nothing; argument binding is step-specific and accepts only authoritative
 * record identifiers or exact permitted source spans; and the ledger records
 * the difference between what Jev recommended and what the application
 * executed, together with every probe considered and the one chosen.
 *
 * ## The claims this example is NOT allowed to make
 *
 * That Jev understands fraud reports. That it is calibrated for banking workflow
 * selection. That it prevents hallucination. That bounded options imply a
 * correct or harmless choice. That this pattern safely automates card freezes or
 * dispute filing, or reduces fraud loss, handling time or clarification turns.
 * That an offline run demonstrates live API behaviour, latency, cost or
 * reliability. That the probes are the right probes, or that their costs and
 * partitions resemble any real institution's.
 *
 * And specifically: **reversibility plus verification makes an action undoable,
 * which is a smaller property than safe.** This example removed a human approval
 * gate. That removed a *demonstration choice*, not a risk. Whether a real card
 * freeze should require authorization is a question about that action and that
 * institution, and this repository does not answer it.
 *
 * The full contract is `docs/CLAIM-CONTRACTS.md`; the limits of the pattern are
 * `docs/FSI-BOUNDARIES.md`.
 *
 * ## What is scripted
 *
 * Only with `JEV_MOCK=1`, `src/mock-fetch.ts` manufactures the selected
 * option *and the shape of the distribution*. Otherwise Jev answers live. The
 * probe partitions and costs in `probes.ts` were written by hand. So a run shows
 * what the application does with a distribution, and cannot show that a
 * distribution deserves trust.
 *
 * Run:  npm run fsi:07
 */

import { VERSION } from '@typesafe-ai/sdk';
import type { Authority } from '../../../src/authority.ts';
import { createAuthority } from '../../../src/authority.ts';
import { isLiveJev } from '../../../src/client.ts';
import { runPlan, validatePlan } from '../../../src/compensate.ts';
import { fixtureBanner, runMode } from '../../../src/fixture-label.ts';
import { assess, eigIsDegenerate, entropy, posterior, selectProbe } from '../../../src/information-gain.ts';
import type { DistributionMetrics, ProbeRecord } from '../../../src/ledger.ts';
import { createLedger, metricsFor, stateReference, summarize } from '../../../src/ledger.ts';
import type { MockScript, ScriptedAnswer } from '../../../src/mock-fetch.ts';
import { bold, cyan, dim, green, note, red, title, yellow } from '../../../src/ui.ts';
import type { EvidenceRecord, StepId, StepSpec, WorkflowContext } from '../../../src/workflow-machine.ts';
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
import { baselineNextStep } from './baseline.ts';
import { createControlArm } from './control-arm.ts';
import { freezePlan, planDigest, planFor, type PlanContext } from './plan.ts';
import {
  decide,
  MIN_PROBE_GAIN,
  MIN_PROBE_GAIN_FRACTION,
  NO_ACTION,
  POLICY_VERSION,
  PROBE_BUDGET,
  thresholdRecord,
} from './policy.ts';
import { assertProbesAreCheap, evidenceFrom, probeById, probeCatalog, PROBES, ACTION_COST } from './probes.ts';
import { buildState, FIELDS_WITHHELD, recommendNextStep, selectCandidate } from './recommend.ts';
import {
  printBound,
  printDegenerateAssessments,
  printDistribution,
  printEligibility,
  printExecution,
  printObservation,
  printPlan,
  printProbeRanking,
  printRejections,
  printReversal,
  printRoute,
  printSummary,
} from './report.ts';
import type { SummaryRow } from './report.ts';
import { CARD_IN_SCOPE, SCENARIOS, seed } from './scenarios.ts';
import type { Scenario } from './scenarios.ts';

const live = isLiveJev();

// A hard failure, before any fixture runs. If a probe ever costs as much as
// acting, the example is arguing for itself dishonestly and should not run.
assertProbesAreCheap();

fixtureBanner(live);
console.log(dim('Customer records, probe observations and action effects are fixtures in both modes; no real banking operations run.'));
title('07 — Uncertainty selects the next machine action');
console.log(
  note(
    [
      'Deterministic code reads the records and decides what is even eligible, then asks',
      'Jev which eligible step comes next. When the answer is flat the application does not',
      'ask anyone: it works out which read would separate the leading candidates, performs',
      'that read, and asks again. When it concentrates, the step is expanded into a plan',
      'whose reversible work is verified before its one irreversible step commits. When the',
      'budget runs out, it refuses and stops.',
    ],
    2,
  ),
);

const ledger = createLedger({
  component: 'fsi-07-next-step',
  mode: runMode(live),
  service: { model: 'unknown (no response yet)', sdkPackage: '@typesafe-ai/sdk', sdkVersion: VERSION },
  // A scripted run is a fixture, and `runId` feeds `planDigest`. With a random
  // id the digests differ on every run, so no document could quote one and no
  // reader could reproduce it. The clock is pinned for the same reason. A live
  // run keeps a fresh id, because there the point is correlating with a real
  // trace rather than diffing against a recorded one.
  ...(live ? {} : { runId: 'run-fsi-07-scripted' }),
  ...(process.env['JEV_LEDGER_FILE'] ? { file: process.env['JEV_LEDGER_FILE'] } : {}),
});

/**
 * Hands out the fixture's scripted answers in order.
 *
 * One per request, including every re-judge after a probe. The last entry
 * repeats, so a fixture that scripts one answer and runs four rounds still runs.
 */
function scriptSource(answers: readonly (ScriptedAnswer | 'throw')[]): () => MockScript | undefined {
  let index = 0;
  return () => {
    if (answers.length === 0) return undefined;
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (answer === undefined) return undefined;
    if (answer === 'throw') {
      return () => {
        throw new Error('socket hang up');
      };
    }
    return () => ({ selection: answer });
  };
}

/** Shannon entropy of a named distribution, in nats. */
function distributionEntropy(distribution: Readonly<Record<string, number>>): number {
  return entropy(Object.values(distribution));
}

function contextFor(
  authority: Authority,
  scenario: Scenario,
  completed: readonly StepId[],
  evidence: readonly EvidenceRecord[],
): WorkflowContext {
  return {
    snapshot: authority.read(),
    principal: scenario.principal,
    cardId: CARD_IN_SCOPE,
    sources: scenario.sources,
    completed,
    evidence,
  };
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

  const nextStepScript = scriptSource(scenario.stepAnswers);
  const argumentScript = scriptSource(scenario.argumentAnswers ?? []);

  /** Steps this run has actually executed, which changes what is eligible next. */
  const completed: StepId[] = [];
  /** Evidence bought across the whole case, carried into every later request. */
  const evidence: EvidenceRecord[] = [];

  const totalRounds = scenario.rounds ?? 1;
  let controlArmDone = false;

  for (let round = 1; round <= totalRounds; round += 1) {
    if (totalRounds > 1) {
      console.log(`\n  ${bold(`── round ${round} of ${totalRounds}`)}`);
    }

    const context = contextFor(authority, scenario, completed, evidence);
    const eligibility = computeEligibility(context);
    printEligibility(eligibility);

    if (eligibility.eligible.length === 0) {
      console.log(`  ${dim('no eligible step remains; the case is done')}`);
      break;
    }

    // -------------------------------------------------------------------
    // The baseline arm: same eligibility, no model.
    // -------------------------------------------------------------------
    const baseline = baselineNextStep(eligibility);
    const baselineLabel = baseline.step?.id ?? '(no eligible step)';

    // -------------------------------------------------------------------
    // The adversarial control-arm fixture, where the scenario has one.
    // -------------------------------------------------------------------
    if (scenario.controlArm && !controlArmDone) {
      controlArmDone = true;
      const arm = createControlArm(scenario.controlArm);
      const proposed = await arm.propose(buildState(context));
      const armStep = stepById(proposed.stepId);
      console.log(
        `\n  ${bold('control arm')} ${dim(`${arm.modelId} · schema-valid, records unchecked`)}`,
      );
      if (armStep) {
        const armBinding = bindArguments(armStep, proposed.arguments, context);
        if (armBinding.ok) {
          console.log(
            `  ${yellow('bound')} ${dim('unexpectedly — the fixture no longer demonstrates its point')}`,
          );
        } else {
          printRejections('generative proposal', armBinding.rejections);
          console.log(
            note(
              [
                'Rejected by bindArguments, the same function the Jev arm below goes through.',
                'This is an adversarial fixture, not a fair benchmark: a competent generative',
                'implementation can be constrained to enumerated record IDs and would pass the',
                'same checks, for the same reason — the checks are in the application.',
              ],
              2,
            ),
          );
        }
        ledger.record({
          service: { model: arm.modelId, sdkPackage: 'ai/test', sdkVersion: 'fixture' },
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
          executed: { action: NO_ACTION, divergedFromRecommendation: true },
          latencyMs: 0,
        });
      }
      console.log('');
    }

    // -------------------------------------------------------------------
    // Judge, probe, re-judge. The loop that replaced the approval gate.
    // -------------------------------------------------------------------
    const probeRecords: ProbeRecord[] = [];
    const spent = new Set<string>();

    let recommendation = await recommendNextStep(eligibility, context, nextStepScript());
    let latencyMs = recommendation.latencyMs;
    let metrics: DistributionMetrics | null = null;
    let policy = null as ReturnType<typeof decide> | null;
    let chosenStep: StepSpec | null = null;

    for (;;) {
      metrics =
        recommendation.probabilities && recommendation.choice
          ? metricsFor(recommendation.probabilities, recommendation.choice, recommendation.optionIds)
          : null;

      chosenStep =
        recommendation.choice && recommendation.choice !== NONE_OF_THESE
          ? (eligibility.eligible.find((step) => step.id === recommendation.choice) ?? null)
          : null;

      if (recommendation.failure) {
        if (live) {
          process.exitCode = 1;
          console.error(`  ${red('live Jev request failed')} ${dim(recommendation.failure)}`);
        } else {
          console.log(`  ${red('service')} ${dim(recommendation.failure)}`);
        }
      } else {
        console.log(`\n  ${bold('jev recommends')} ${cyan(recommendation.choice ?? '(nothing)')}`);
        printDistribution(recommendation.probabilities, metrics);
      }

      // Ask the EIG kernel what is worth reading *given this distribution*,
      // over the options actually offered. A probe already spent is excluded:
      // reading the same record twice buys nothing the second time.
      const prior = recommendation.probabilities ?? {};
      const selection = selectProbe(prior, probeCatalog(), {
        minimumGain: MIN_PROBE_GAIN,
        minimumGainFraction: MIN_PROBE_GAIN_FRACTION,
        exclude: [...spent],
      });

      policy = decide({
        metrics,
        choice: recommendation.choice,
        step: chosenStep,
        failure: recommendation.failure,
        probesRun: probeRecords.length,
        probeAvailable: selection.chosen !== null,
        probeReason: selection.reason,
      });
      printRoute(policy);

      if (policy.route !== 'probe' || selection.chosen === null) break;

      // -----------------------------------------------------------------
      // Buy the evidence.
      // -----------------------------------------------------------------
      const chosen = selection.chosen;
      console.log(
        `\n  ${bold('probe')} ${dim(`${probeRecords.length + 1} of ${PROBE_BUDGET} · ranked by expected gain per unit cost`)}`,
      );
      printProbeRanking(selection.ranked, chosen.probe.id);

      const workflowProbe = probeById(chosen.probe.id);
      if (!workflowProbe) break;

      const snapshot = authority.read();
      const observed = workflowProbe.run({ snapshot, cardId: CARD_IN_SCOPE });
      const record = evidenceFrom(workflowProbe, observed, snapshot);
      evidence.push(record);
      spent.add(chosen.probe.id);

      // The posterior the observation actually produced, not the expectation.
      const posteriorEntropy = distributionEntropy(
        posterior(prior, chosen.probe, observed.observation),
      );
      printObservation(
        chosen.probe.id,
        workflowProbe.reads,
        observed.observation,
        observed.detail,
        chosen.priorEntropy,
        posteriorEntropy,
      );

      probeRecords.push({
        probeId: chosen.probe.id,
        expectedInformationGain: chosen.expectedInformationGain,
        priorEntropy: chosen.priorEntropy,
        observation: observed.observation,
        posteriorEntropy,
        costUnits: chosen.probe.cost,
        // The full ranking as it stood *before* the observation came back. The
        // counterfactual — what else was on the table — is not recoverable from
        // the chosen probe alone.
        considered: selection.ranked.map((entry) => ({
          probeId: entry.probe.id,
          expectedInformationGain: entry.expectedInformationGain,
          costUnits: entry.probe.cost,
        })),
      });

      // Re-judge. A different question, because the state now carries the
      // observation — not a retry of the same one.
      const context2 = contextFor(authority, scenario, completed, evidence);
      recommendation = await recommendNextStep(eligibility, context2, nextStepScript());
      latencyMs += recommendation.latencyMs;
      console.log(`  ${dim('re-judging with the observation in the state')}`);
    }

    const decided = policy;
    if (decided === null) break;

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

    /** Records the decision and closes out this round. */
    function close(
      action: string,
      outcome: string,
      args?: Record<string, string>,
      execution?: Parameters<typeof ledger.record>[0]['execution'],
    ): void {
      ledger.record({
        service: { model: recommendation.model || 'unknown', sdkPackage: '@typesafe-ai/sdk', sdkVersion: VERSION },
        state: stateReference(buildState(context), FIELDS_WITHHELD),
        candidates: candidateProvenance,
        recommendation: recommendationRecord,
        metrics,
        probes: probeRecords,
        ...(execution ? { execution } : {}),
        policy: {
          policyVersion: POLICY_VERSION,
          thresholds: thresholdRecord(),
          route: decided.route,
          reason: decided.reason,
        },
        executed: { action, ...(args ? { arguments: args } : {}) },
        ...(recommendation.failure
          ? {
              failure: {
                kind: 'service_error' as const,
                detail: recommendation.failure,
                fallback: 'refused; nothing changed',
              },
            }
          : {}),
        latencyMs,
      });
      rows.push({
        scenario: totalRounds > 1 ? `${scenario.id}#${round}` : scenario.id,
        recommended: recommendation.choice ?? '(none)',
        route: decided.route,
        probes: probeRecords.length === 0 ? '—' : probeRecords.map((p) => p.probeId).join('+'),
        executed: action,
        outcome,
        baseline: baselineLabel,
      });
      console.log(`  ${dim(`baseline arm would have taken: ${baselineLabel}`)}`);
    }

    if (decided.route === 'refused' || chosenStep === null) {
      console.log(
        note(
          [
            'Nothing was changed and nothing was handed anywhere. This is where the run ends',
            'for this case: a refusal is a terminal state of the program, not a destination.',
          ],
          2,
        ),
      );
      close(decided.action, 'refused');
      break;
    }

    printReversal(chosenStep);

    // -------------------------------------------------------------------
    // Stage two: bind arguments, step-specifically.
    // -------------------------------------------------------------------
    const proposedArguments: Record<string, string> = deterministicArguments(chosenStep, context);
    const open = slotsNeedingSelection(chosenStep, context);
    let abandoned = false;

    for (const slot of open) {
      const candidates = candidatesFor(chosenStep, slot, context);
      console.log(
        `\n  ${bold('stage two')} ${dim(`${slot.name}: ${candidates.length} candidate ${slot.recordType}(s) from the records`)}`,
      );
      const selected = await selectCandidate(candidates, slot.description, context, argumentScript());
      latencyMs += selected.latencyMs;
      if (selected.failure && live) {
        process.exitCode = 1;
        console.error(`  ${red('live Jev argument request failed')} ${dim(selected.failure)}`);
      }
      if (selected.choice === null || selected.choice === NONE_OF_THESE) {
        console.log(`  ${red('REFUSE')} ${dim('no candidate record matched; nothing changed')}`);
        close(NO_ACTION, 'refused');
        abandoned = true;
        break;
      }
      console.log(`    ${dim(`selected ${selected.choice}`)}`);
      proposedArguments[slot.name] = selected.choice;
    }

    if (abandoned) break;

    const binding = bindArguments(chosenStep, proposedArguments, context);
    if (!binding.ok) {
      printRejections('jev-selected proposal', binding.rejections);
      close(NO_ACTION, 'refused');
      break;
    }
    console.log(`\n  ${bold('bound arguments')}`);
    printBound(binding.bound);

    // -------------------------------------------------------------------
    // Freeze the plan, then run it.
    // -------------------------------------------------------------------
    const frozen = freezePlan(ledger.runId, chosenStep, binding.bound, context);
    const digest = planDigest(frozen);
    const steps = planFor(chosenStep, binding.bound);

    const problems = validatePlan(steps);
    if (problems.length > 0) {
      console.log(`  ${red('REFUSE')} ${dim(`plan is not runnable: ${problems.join('; ')}`)}`);
      close(NO_ACTION, 'refused');
      break;
    }
    printPlan(steps, digest);

    if (scenario.interruption?.when === 'before_commit') {
      authority.applyOutOfBandChange(scenario.interruption.note, scenario.interruption.change);
      console.log(`  ${yellow('records moved')} ${dim(scenario.interruption.note)}`);
    }

    const planContext: PlanContext = {
      authority,
      frozen,
      digest,
      step: chosenStep,
      principal: scenario.principal,
      cardId: CARD_IN_SCOPE,
      sources: scenario.sources,
      completed,
      evidence,
      ...(scenario.failVerificationAt ? { failVerificationAt: scenario.failVerificationAt } : {}),
    };

    const result = await runPlan(steps, planContext);
    printExecution(result);

    const execution = {
      outcome: result.outcome,
      reason: result.reason,
      stepsAttempted: result.steps.length,
      stepsVerified: result.steps.filter((entry) => entry.verified).length,
      ...(result.inconsistentAt ? { inconsistentAt: result.inconsistentAt } : {}),
    };

    if (result.outcome === 'completed') {
      completed.push(chosenStep.id);
      close(chosenStep.id, result.outcome, plainArguments(binding.bound), execution);
    } else {
      close(NO_ACTION, result.outcome, undefined, execution);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
title('Recommended vs executed');
printSummary(rows);
console.log(
  note(
    [
      'Rows where `harness executed` differs from `jev recommended` are the interesting',
      'ones. The ledger stores both, separately, and derives the difference. The `probes`',
      'column names the reads that were bought before the row was decided.',
    ],
    2,
  ),
);

// ---------------------------------------------------------------------------
title('A point estimate has nothing for a probe to remove');
console.log(
  note(
    [
      'The same six probes, assessed twice by the same kernel. On the left-hand run the',
      'prior is an authored arithmetic example, not a response from this run. On the right it is a point estimate —',
      'one option at 1.0 — which is the shape a single-answer model returns.',
    ],
    2,
  ),
);

const contestedPrior = {
  send_transaction_receipt: 0.41,
  open_dispute: 0.36,
  freeze_card: 0.13,
  schedule_callback: 0.05,
  record_customer_note: 0.05,
};
const pointEstimate = {
  send_transaction_receipt: 1,
  open_dispute: 0,
  freeze_card: 0,
  schedule_callback: 0,
  record_customer_note: 0,
};

console.log(
  `\n  ${bold('contested prior')} ${dim(`H=${distributionEntropy(contestedPrior).toFixed(4)} nats`)}`,
);
printDegenerateAssessments(PROBES.map((entry) => assess(contestedPrior, entry.probe)));

console.log(
  `\n  ${bold('point estimate')} ${dim(`H=${distributionEntropy(pointEstimate).toFixed(4)} nats`)}`,
);
printDegenerateAssessments(PROBES.map((entry) => assess(pointEstimate, entry.probe)));
console.log(
  `\n  ${dim('eigIsDegenerate(point estimate) =')} ${bold(String(eigIsDegenerate(pointEstimate)))}` +
    `   ${dim('selectProbe says:')} ${dim(selectProbe(pointEstimate, probeCatalog()).reason)}`,
);
console.log(
  note(
    [
      'Zero entropy in, an unchanged posterior out, and therefore exactly zero expected',
      'gain for every probe in the catalog. That is not a tuning problem and no threshold',
      'fixes it: a model that returns one answer supplies no basis for choosing which',
      'lookup to run, because it reports nothing that a lookup could reduce. The probe',
      'selection in this example is downstream of the distribution existing at all.',
      '',
      'Note also what the arithmetic is and is not. The kernel computes the expected',
      'entropy reduction correctly over the numbers it is given. Whether those numbers',
      'are a faithful prior is exactly what this repository does not establish.',
    ],
    2,
  ),
);

// ---------------------------------------------------------------------------
title('Where the safety properties live');
console.log(
  dim(
    'ineligible action cannot be selected    computeEligibility()   deterministic\n' +
      'principal cannot exceed entitlement     permits()              deterministic\n' +
      'argument must resolve to a record       bindArguments()        deterministic\n' +
      'narrative must be the customer’s words  resolveSpan()          deterministic\n' +
      'probes cannot write                     probes.ts + authority  deterministic\n' +
      'probes cost less than acting            assertProbesAreCheap() deterministic\n' +
      'plan shape: one irreversible step, last validatePlan()         deterministic\n' +
      'reversible work verified before commit  runPlan()              deterministic\n' +
      'failure unwinds in reverse order        runPlan() rollback     deterministic\n' +
      'plan binds to one frozen digest         planDigest()           deterministic\n' +
      'state cannot go stale before the commit preflight()            deterministic\n' +
      'which eligible step to try first        Jev                    unmeasured\n' +
      'when the case is too unclear to act     Jev + policy           unmeasured\n' +
      'whether a bought observation is apt     Jev                    unmeasured',
  ),
);
console.log(
  note(
    [
      'The deterministic rows are properties of code in this repository and a reader can',
      'check them by reading it. The `unmeasured` rows concern quality, not whether a',
      'request was made. Live answers on synthetic cases do not establish correctness,',
      'calibration or fitness for real banking operations.',
      '',
      'Read the whole table for what it is. Every row above the line makes an action',
      'undoable and confirms it happened. None of them makes an action appropriate. This',
      'example replaced a human approval gate with evidence-gathering, and that was a',
      'change of demonstration, not a reduction in risk: whether a real card freeze or a',
      'real chargeback ought to require authorization is a question about that action in',
      'that institution, and this repository does not answer it.',
    ],
    2,
  ),
);
console.log(
  note(
    [
      'The baseline column records static-priority selection over the same eligible steps.',
      'It does not execute a separate workflow or establish matching refusal outcomes.',
      'What static priority cannot do is be uncertain',
      '— static priority always has an answer, so there is never a moment at which it would',
      'go and read something. Whether preselection, probing or refusal is worth anything',
      'here is not measured by this repository.',
    ],
    2,
  ),
);

// ---------------------------------------------------------------------------
title('Ledger');
for (const entry of ledger.entries()) console.log(`  ${summarize(entry)}`);
console.log(
  `\n  ${dim(`${ledger.entries().length} records, mode ${runMode(live)}. Set JEV_LEDGER_FILE to write JSONL.`)}\n` +
    `  ${dim('Evidence capture that may support governance. Not an audit trail: not')}\n` +
    `  ${dim('tamper-evident, not immutable, not independently verified, and a hashed')}\n` +
    `  ${dim('state reference is not anonymization.')}`,
);
console.log(
  note(
    [
      `Probe costs are in notional units against a notional action cost of ${ACTION_COST}.`,
      'They are invented. The ordering between them is the part worth defending; the',
      'ratios are not, and no institution should read a budget off this.',
    ],
    2,
  ),
);
