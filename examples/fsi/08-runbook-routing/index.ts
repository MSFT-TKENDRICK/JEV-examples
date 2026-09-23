/**
 * 08 — Residual incident runbook routing, by expected information gain.
 *
 * An overnight batch window produces sixteen incidents. Deterministic sources
 * answer most of them: the scheduler's dependency graph, the incident system's
 * open alerts, the restart policy, the reconciliation control and the abend
 * mapping table. What is left is the **residual** — incidents where several
 * remediations genuinely apply and nothing authoritative decides between them.
 *
 * What happens next is the point of this example.
 *
 * ## The distribution selects the next machine action
 *
 * Jev returns a distribution over **remediation** runbooks. When that
 * distribution is concentrated, the application executes the remediation,
 * reversibly, and verifies it. When it is not, the application does **not** hand
 * the incident to a person. It uses the shape of the distribution to select a
 * **diagnostic** runbook — read-only, cheaper than remediating, and chosen
 * because its possible observations would split the remediation candidates more
 * than any other affordable diagnostic would. It runs it, folds the observation
 * into the state, and asks again. When the budget runs out without the
 * distribution concentrating, it refuses: it stops, says what it could not
 * establish, and has changed nothing.
 *
 * Probe, act reversibly, or refuse. There is no fourth option and no queue.
 *
 * ## Why a distribution is structurally required here
 *
 * Expected information gain is `H(prior) - E[H(posterior)]`. For a point
 * estimate `H(prior) = 0`, and the posterior under any observation is the same
 * point mass, so every term is zero for **every** diagnostic. An argmax model
 * does not find diagnostic selection harder — it finds every diagnostic exactly
 * as worthless as every other, with no tie-break available, because the quantity
 * being compared is identically zero. The run demonstrates this at the end
 * rather than asserting it.
 *
 * ## Claim contract (docs/CLAIM-CONTRACTS.md, Example 08)
 *
 * May claim:
 * - Known structured mappings and dependency conditions are resolved
 *   deterministically first, before any request is built.
 * - Jev receives only a controlled catalog of candidate remediations plus
 *   `none-of-these`.
 * - When the distribution does not support acting, the application selects a
 *   read-only diagnostic by expected information gain, runs it, and re-judges.
 * - Diagnostic selection ranks on gain per unit cost, so the highest-gain
 *   diagnostic is not always the one run.
 * - When the probe budget is exhausted without the distribution concentrating,
 *   the application refuses and has changed nothing.
 * - Remediation runs reversibly, verifies each step, and rolls back in reverse
 *   order when verification fails.
 * - The safe path does not depend on Jev returning a correct answer.
 * - Log preprocessing extracts bounded diagnostic windows and deterministically
 *   redacts the configured fields before anything is sent. Redaction is
 *   pattern-based: content matching no configured pattern survives into the
 *   request.
 * - Scripted fixtures exercise confident, probe-resolved, budget-exhausted,
 *   malformed-response, timeout and rollback paths.
 * - The ledger retains the full probe trail with prior and posterior entropy.
 *
 * Must not claim: that Jev identifies root cause; that it understands abend
 * codes or spool output; that it selects the *correct* remediation; that the
 * probabilities are calibrated; that the diagnostics are the ones a real SRE
 * team would run, or that their costs reflect real execution times — **both are
 * authored in this repository**; that EIG makes the probe sequence optimal (it
 * is greedy, one step of lookahead, no planning over sequences); that fewer
 * probes than a naive ordering means fewer probes against a real incident
 * population — it means fewer probes against *these fixtures*; that the pattern
 * reduces MTTR or misrouting; that the catalog, CMDB or flow snapshot is
 * complete or current; that a recent deployment caused anything; that this is
 * safe to automate without task-specific validation; or that an offline run
 * demonstrates live reliability, cost or latency.
 *
 * The arithmetic is real. Incident inputs are synthetic; Jev distributions are
 * live unless `JEV_MOCK=1` explicitly selects the scripted fixture transport.
 *
 * Run:  npm run fsi:08
 */

import { APIConnectionError, VERSION, choice, noul } from '@typesafe-ai/sdk';
import { activeBackend, isLiveJev } from '../../../src/client.ts';
import { fixtureBanner, runMode } from '../../../src/fixture-label.ts';
import { entropy } from '../../../src/information-gain.ts';
import type { Assessment } from '../../../src/information-gain.ts';
import {
  createLedger,
  hashState,
  metricsFor,
  stateReference,
  summarize,
} from '../../../src/ledger.ts';
import type { DecisionInput, ProbeRecord } from '../../../src/ledger.ts';
import { diagnosticWindow, redactionSummary } from '../../../src/log-redact.ts';
import {
  CATALOG_VERSION,
  DIAGNOSTIC_OBSERVATION_SOURCE,
  FLOW_SNAPSHOT_VERSION,
  NONE_OPTION,
  REMEDIATIONS_BY_ID,
  candidateCriteria,
  candidateRemediations,
  ownershipNotes,
  preconditionsHold,
} from '../../../src/runbook-catalog.ts';
import { bold, cyan, dim, green, note, red, title, yellow } from '../../../src/ui.ts';
import { resolveDeterministically } from './deterministic.ts';
import { INCIDENTS } from './fixtures.ts';
import type { Incident } from './fixtures.ts';
import {
  assessApplicable,
  chooseProbe,
  consideredFrom,
  eigIsDegenerate,
  fold,
  observe,
} from './investigate.ts';
import { INVESTIGATION, POLICY_VERSION, THRESHOLDS, decide, refusalFor } from './policy.ts';
import type { Route } from './policy.ts';
import { remediate, stepCounts } from './remediate.ts';
import { routingClient } from './transport.ts';

// The disclosure prints before anything else, on every run.
const live = isLiveJev();
fixtureBanner(live);
console.log(dim('Incident records, diagnostic observations, costs and remediation effects are fixtures in both modes.'));
if (live) console.log(dim('Jev responses are live; scripted transport faults and scripted answer notes are disabled.'));

const ledger = createLedger({
  component: '08-runbook-routing',
  mode: runMode(live),
  file: process.env['JEV_LEDGER_FILE'],
  service: { model: 'unknown', sdkPackage: '@typesafe-ai/sdk', sdkVersion: VERSION },
  // Pinned for a scripted run so the recorded ledger is reproducible and can be
  // quoted; fresh for a live run, where correlating with a real trace is the
  // point. Same reasoning as the fixed clock.
  ...(live ? {} : { runId: 'run-fsi-08-scripted' }),
});

/**
 * Fields deliberately kept out of every request.
 *
 * `cmdbOwner` is the interesting entry: ownership is metadata, so the model is
 * never shown it and can never be said to have chosen a team. `releaseTrain` is
 * withheld for a different reason — offering a recent deployment alongside a
 * failure invites a causal reading the evidence does not support.
 */
const WITHHELD = [
  'rawSpool',
  'accountAndCardIdentifiers',
  'redactionMapping',
  'cmdbOwner',
  'releaseTrain',
  'customerRecords',
] as const;

const ROUTE_STYLE: Record<Route, (text: string) => string> = {
  deterministic_runbook: green,
  linked_to_predecessor: dim,
  scheduler_retry: dim,
  suppressed_duplicate: dim,
  freeze_downstream: red,
  probe: cyan,
  act: green,
  rolled_back: yellow,
  inconsistent: red,
  refused: yellow,
};

/** What the SDK's typed answer looks like once it has actually been checked. */
interface CheckedAnswers {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number | undefined;
  evidenceSufficient: number;
}

/**
 * Validates a response before trusting any field on it.
 *
 * The SDK types promise a `choice` and a `probabilities` map; it does not verify
 * that the service sent them. This is not defensive programming for its own
 * sake — the malformed fixture returns HTTP 200 with those fields missing, and
 * without this check the application routes on `undefined`.
 *
 * The option-set check matters just as much: an answer naming a procedure that
 * was never offered is a response-integrity failure, not a recommendation.
 */
function checkAnswers(raw: unknown, offered: readonly string[]): CheckedAnswers | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const answers = raw as Record<string, unknown>;
  const first = answers['first_remediation'];
  const sufficiency = answers['evidence_sufficient'];
  if (typeof first !== 'object' || first === null) return null;

  const { choice: selected, probabilities, confidence } = first as Record<string, unknown>;
  if (typeof selected !== 'string' || !offered.includes(selected)) return null;
  if (typeof probabilities !== 'object' || probabilities === null) return null;

  const distribution: Record<string, number> = {};
  for (const [option, value] of Object.entries(probabilities as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (!offered.includes(option)) return null;
    distribution[option] = value;
  }
  if (distribution[selected] === undefined) return null;

  const noulValue =
    typeof sufficiency === 'object' && sufficiency !== null
      ? (sufficiency as Record<string, unknown>)['noul']
      : undefined;

  return {
    choice: selected,
    probabilities: distribution,
    confidence: typeof confidence === 'number' ? confidence : undefined,
    // A missing sufficiency answer is treated as no evidence of sufficiency,
    // which fails the threshold rather than passing it.
    evidenceSufficient: typeof noulValue === 'number' ? noulValue : 0,
  };
}

function header(incident: Incident): void {
  const cis = incident.components.join(', ');
  console.log(
    `\n${bold(incident.id)}  ${incident.job}${incident.step ? `/${incident.step}` : ''}  ` +
      dim(
        `flow=${incident.flow} · CIs=${cis} · scheduler=${incident.scheduler.state}` +
          (incident.abendCode ? ` · abend=${incident.abendCode}` : '') +
          (incident.scheduler.slaAt ? ` · SLA ${incident.scheduler.slaAt.slice(11)}` : ''),
      ),
  );
}

function routeLine(route: Route, detail: string): void {
  console.log(`  ${ROUTE_STYLE[route](route.toUpperCase().replace(/_/g, ' '))}  ${detail}`);
}

function pctOf(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function topOf(distribution: Readonly<Record<string, number>>, count = 3): string {
  return Object.entries(distribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([option, p]) => `${option} ${pctOf(p)}`)
    .join(' · ');
}

/**
 * Prints the ranked assessment table.
 *
 * Both columns are shown deliberately. `gain` is what the diagnostic is expected
 * to remove; `gain/cost` is what it is expected to remove per unit spent, and
 * that is what the selector ranks on. When the top of one column is not the top
 * of the other, the trade is marked — that divergence is the whole argument for
 * ranking on cost efficiency, and it should be readable rather than asserted.
 */
function probeTable(
  ranked: readonly Assessment[],
  unaffordable: readonly Assessment[],
  chosenId: string | null,
): void {
  if (ranked.length === 0 && unaffordable.length === 0) return;

  const sharpest = [...ranked].sort(
    (a, b) => b.expectedInformationGain - a.expectedInformationGain,
  )[0];

  const lines: string[] = [];
  for (const assessment of ranked) {
    const id = assessment.probe.id;
    const marker = id === chosenId ? '→' : ' ';
    const flag =
      chosenId !== null && sharpest && id === sharpest.probe.id && id !== chosenId
        ? '  ← sharpest, but not the best value'
        : '';
    lines.push(
      `${marker} ${id.padEnd(22)} cost ${String(assessment.probe.cost).padStart(2)}  ` +
        `gain ${assessment.expectedInformationGain.toFixed(3)}  ` +
        `gain/cost ${assessment.gainPerCost.toFixed(3)}${flag}`,
    );
  }
  for (const assessment of unaffordable) {
    lines.push(
      `  ${assessment.probe.id.padEnd(22)} cost ${String(assessment.probe.cost).padStart(2)}  ` +
        `gain ${assessment.expectedInformationGain.toFixed(3)}  ` +
        `gain/cost ${assessment.gainPerCost.toFixed(3)}  ← outside the remaining budget`,
    );
  }
  console.log(note(lines));
}

title('08 — Residual incident runbook routing, by expected information gain');
console.log(
  dim(
    `${INCIDENTS.length} incidents from one overnight window. Deterministic sources run first;\n` +
      'what they cannot settle is put to Jev as a bounded choice over applicable remediations.\n' +
      'An ambiguous answer selects a read-only diagnostic, never a person.',
  ),
);

let requestsMade = 0;
let probesRunTotal = 0;
let probeCostTotal = 0;
const routeCounts = new Map<Route, number>();
/** Kept for the closing demonstration, so it uses a real prior from this run. */
let degeneracyExhibit: { incident: Incident; prior: Record<string, number> } | null = null;

for (const incident of INCIDENTS) {
  header(incident);

  // -------------------------------------------------------------------------
  // Stage 1: the lookups. Never ask a model what a lookup can determine.
  // -------------------------------------------------------------------------
  const outcome = resolveDeterministically(incident);

  if (outcome.resolved) {
    routeLine(outcome.route, `${outcome.action} — ${outcome.reason}`);
    console.log(
      `  ${dim(`source: ${outcome.source}@${outcome.sourceVersion} · no request built · no diagnostic run · spool never left the process`)}`,
    );

    ledger.record({
      service: { model: 'none (no request)', sdkPackage: '@typesafe-ai/sdk', sdkVersion: VERSION },
      state: {
        hash: hashState(null),
        fieldsSent: [],
        fieldsWithheld: ['all — the deterministic stage resolved this incident'],
      },
      candidates: {
        source: outcome.source,
        version: outcome.sourceVersion,
        optionIds: outcome.runbookId ? [outcome.runbookId] : [],
        readAt: new Date().toISOString(),
      },
      policy: {
        policyVersion: POLICY_VERSION,
        thresholds: {},
        route: outcome.route,
        reason: outcome.reason,
      },
      executed: { action: outcome.action },
      latencyMs: 0,
    } satisfies DecisionInput);

    routeCounts.set(outcome.route, (routeCounts.get(outcome.route) ?? 0) + 1);
    continue;
  }

  // -------------------------------------------------------------------------
  // Stage 2: bound and redact the evidence, then bound the option set.
  // -------------------------------------------------------------------------
  console.log(`  ${dim(`residual (${outcome.residual}): ${outcome.reason}`)}`);

  const window = diagnosticWindow(incident.spool);
  const candidates = candidateRemediations(incident.components);
  const criteria = candidateCriteria(candidates);
  const offered = Object.keys(criteria);

  console.log(
    `  ${dim(
      `window: lines ${window.startLine}–${window.endLine} of ${window.sourceLineCount} · ` +
        `redaction: ${redactionSummary(window.redaction)}`,
    )}`,
  );
  console.log(
    `  ${dim(`candidates: ${candidates.length} applicable remediation(s) + ${NONE_OPTION} · withheld: ${WITHHELD.join(', ')}`)}`,
  );
  for (const ownership of ownershipNotes(incident.components)) {
    console.log(`  ${dim(`ownership: ${ownership} (recorded, not a route)`)}`);
  }

  // -------------------------------------------------------------------------
  // Stage 3: the investigation loop.
  // -------------------------------------------------------------------------
  const probeRecords: ProbeRecord[] = [];
  const findings: Array<{ diagnostic: string; observation: string; derivation: string }> = [];
  const budget = { probesRun: 0, costSpent: 0 };
  let totalLatency = 0;
  let settled = false;

  while (!settled) {
    const round =
      incident.rounds?.[Math.min(probeRecords.length, incident.rounds.length - 1)] ?? undefined;

    const { client } = routingClient(
      () =>
        round
          ? {
              first_remediation: { distribution: round.distribution },
              evidence_sufficient: { noul: round.evidenceSufficient },
            }
          : {},
      incident.fault,
    );

    // Findings accumulate into the state, which is what makes the loop a loop:
    // each request sees everything the diagnostics have established so far.
    const state = {
      flow: incident.flow,
      job: incident.job,
      step: incident.step ?? null,
      abendCode: incident.abendCode ?? null,
      affectedComponents: [...incident.components],
      schedulerState: {
        state: incident.scheduler.state,
        predecessor: incident.scheduler.predecessor?.job ?? null,
        predecessorState: incident.scheduler.predecessor?.state ?? null,
      },
      diagnosticWindow: [...window.lines],
      windowProvenance: {
        anchoredOnLine: window.anchorLine,
        ofSpoolLines: window.sourceLineCount,
        truncated: window.truncated,
        redactions: Object.fromEntries(Object.entries(window.redaction.counts)) as Record<
          string,
          number
        >,
      },
      // Carried as untrusted input and labelled as such: free text typed by a
      // person on a bridge call. Instructions inside it are not commands.
      operatorNote: incident.operatorNote
        ? { untrustedText: incident.operatorNote, treatAsData: true }
        : null,
      diagnosticFindings: findings.map((finding) => ({
        diagnostic: finding.diagnostic,
        observed: finding.observation,
      })),
      candidateRemediations: candidates.map((remediation) => ({
        id: remediation.id,
        title: remediation.title,
        firstStep: remediation.plan[0]?.description ?? 'unspecified',
      })),
    };

    const questions = {
      first_remediation: choice(
        'Which of these remediation procedures does the supplied evidence point to? Choose ' +
          'none-of-these if the evidence does not distinguish between them or no listed ' +
          'procedure fits.',
        criteria,
      ),
      evidence_sufficient: noul(
        'Does the supplied evidence contain enough information to distinguish between the ' +
          'listed remediations?',
        {
          true: 'The evidence identifies a condition matching one listed remediation',
          false: 'The evidence is truncated, ambiguous, or consistent with several remediations',
        },
      ),
    };

    requestsMade++;

    const { value: response, latencyMs } = await ledger.timed(() =>
      client
        .systemOne({ state, questions })
        .then((result) => ({ ok: true as const, result }))
        .catch((error: unknown) => ({ ok: false as const, error })),
    );
    totalLatency += latencyMs;

    const baseRecord = {
      service: {
        model: response.ok ? response.result.model : 'unknown',
        sdkPackage: '@typesafe-ai/sdk',
        sdkVersion: VERSION,
      },
      state: stateReference(state, [...WITHHELD]),
      candidates: {
        source: 'runbook-catalog',
        version: `${CATALOG_VERSION} (flow snapshot ${FLOW_SNAPSHOT_VERSION})`,
        optionIds: offered,
        readAt: new Date().toISOString(),
      },
      latencyMs: totalLatency,
      ...(probeRecords.length > 0 ? { probes: [...probeRecords] } : {}),
    };

    // --- Failure paths. A call that cannot answer is not an answer. ---------
    const checked = response.ok ? checkAnswers(response.result.answers, offered) : null;

    if (!response.ok || !checked) {
      const kind = !response.ok
        ? response.error instanceof APIConnectionError
          ? ('timeout' as const)
          : ('service_error' as const)
        : ('malformed_response' as const);
      const detail = !response.ok
        ? response.error instanceof Error
          ? response.error.message
          : String(response.error)
        : 'response missing a usable choice or probabilities';

      if (live) {
        process.exitCode = 1;
        console.error(`  ${red('live Jev request failed')} ${kind}: ${detail}`);
      }
      const decision = refusalFor(kind);
      routeLine(decision.route, decision.reason);
      console.log(`  ${dim(`${kind}: ${detail} (${latencyMs}ms) · nothing was executed`)}`);

      ledger.record({
        ...baseRecord,
        policy: {
          policyVersion: POLICY_VERSION,
          thresholds: THRESHOLDS,
          route: decision.route,
          reason: decision.reason,
        },
        executed: { action: 'no-action' },
        failure: { kind, detail, fallback: 'refused; the incident is left exactly as found' },
      } satisfies DecisionInput);

      routeCounts.set(decision.route, (routeCounts.get(decision.route) ?? 0) + 1);
      settled = true;
      break;
    }

    // --- Policy over the distribution, then revalidation against state. -----
    const metrics = metricsFor(checked.probabilities, checked.choice, offered);
    const recommended = REMEDIATIONS_BY_ID.get(checked.choice);
    const precondition =
      recommended === undefined ? { holds: true } : preconditionsHold(recommended, incident.components);

    const decision = decide({
      choice: checked.choice,
      metrics,
      evidenceSufficient: checked.evidenceSufficient,
      isNoneOption: checked.choice === NONE_OPTION,
      precondition,
    });

    const label = probeRecords.length === 0 ? 'judgement' : `re-judgement ${probeRecords.length}`;
    console.log(
      `  ${dim(
        `${label}: ${topOf(checked.probabilities)}` +
          ` · margin ${metrics.margin.toFixed(2)} · H ${entropy(Object.values(checked.probabilities)).toFixed(3)} nats` +
          ` · sufficiency ${(checked.evidenceSufficient * 100).toFixed(0)}%`,
      )}`,
    );
    if (!live && round?.note) console.log(`  ${dim(`fixture: ${round.note}`)}`);

    if (degeneracyExhibit === null && incident.id === 'INC-4479') {
      degeneracyExhibit = { incident, prior: { ...checked.probabilities } };
    }

    const recordFor = (
      route: Route,
      reason: string,
      action: string,
      extra: Partial<DecisionInput> = {},
    ): void => {
      ledger.record({
        ...baseRecord,
        recommendation: {
          choice: checked.choice,
          ...(checked.confidence === undefined ? {} : { confidence: checked.confidence }),
          probabilities: checked.probabilities,
        },
        metrics,
        policy: {
          policyVersion: POLICY_VERSION,
          thresholds: THRESHOLDS,
          route,
          reason,
        },
        executed: { action },
        ...extra,
      } as DecisionInput);
      routeCounts.set(route, (routeCounts.get(route) ?? 0) + 1);
    };

    // --- Concentrated enough to act: remediate, reversibly. -----------------
    if (decision.route === 'act' && recommended) {
      const { result, world, problems } = await remediate(
        recommended,
        incident.id,
        incident.failingStep,
      );
      const counts = stepCounts(result);
      const route: Route =
        result.outcome === 'completed'
          ? 'act'
          : result.outcome === 'rolled_back'
            ? 'rolled_back'
            : result.outcome === 'inconsistent'
              ? 'inconsistent'
              : 'refused';

      routeLine(route, `${recommended.id} — ${result.reason}`);
      if (problems.length > 0) console.log(`  ${red(`plan problems: ${problems.join('; ')}`)}`);
      console.log(note(world.journal));

      recordFor(route, decision.reason, recommended.id, {
        execution: {
          outcome: result.outcome,
          reason: result.reason,
          stepsAttempted: counts.attempted,
          stepsVerified: counts.verified,
          ...(result.inconsistentAt ? { inconsistentAt: result.inconsistentAt } : {}),
        },
      });
      settled = true;
      break;
    }

    // --- Blocked categorically: no diagnostic would change it. --------------
    if (!decision.probeable) {
      routeLine('refused', decision.reason);
      for (const failure of decision.failed) console.log(`  ${dim(`· ${failure}`)}`);
      recordFor('refused', decision.reason, 'no-action');
      settled = true;
      break;
    }

    // --- Ambiguous: the distribution selects the next read-only action. -----
    const next = chooseProbe(checked.probabilities, incident, budget, [
      ...probeRecords.map((record) => record.probeId),
    ]);

    if (next.kind === 'stop') {
      probeTable(next.ranked, next.unaffordable, null);
      const reason = `${decision.reason}; no further probing (${next.reason})`;
      routeLine('refused', reason);
      for (const failure of decision.failed) console.log(`  ${dim(`· ${failure}`)}`);
      console.log(
        `  ${dim(`spent ${budget.probesRun}/${INVESTIGATION.maxProbes} probes and ${budget.costSpent}/${INVESTIGATION.maxCostUnits} cost units · nothing was executed`)}`,
      );
      recordFor('refused', reason, 'no-action');
      settled = true;
      break;
    }

    probeTable(next.ranked, next.unaffordable, next.probe.id);

    const observation = observe(incident, next.diagnostic.id);
    const folded = fold(checked.probabilities, next.probe, observation.value);

    routeLine(
      'probe',
      `${next.diagnostic.id} (cost ${next.diagnostic.costUnits}) — ${next.diagnostic.title}`,
    );
    console.log(
      `  ${dim(
        `reads ${next.diagnostic.reads} · observed "${observation.value}" ` +
          `[${observation.source}: ${observation.derivation}]`,
      )}`,
    );
    console.log(
      `  ${dim(
        `H ${folded.priorEntropy.toFixed(3)} → ${folded.predictedPosteriorEntropy.toFixed(3)} nats predicted by Bayes` +
          ` (expected gain ${next.assessment.expectedInformationGain.toFixed(3)})` +
          (folded.uninformative ? ' · observation is in no bucket, so the update is a no-op' : ''),
      )}`,
    );

    budget.probesRun += 1;
    budget.costSpent += next.diagnostic.costUnits;
    probesRunTotal += 1;
    probeCostTotal += next.diagnostic.costUnits;

    findings.push({
      diagnostic: next.diagnostic.id,
      observation: observation.value,
      derivation: observation.derivation,
    });

    // This is the posterior predicted by the authored diagnostic partition,
    // not a measurement of the next Jev response.
    probeRecords.push({
      probeId: next.diagnostic.id,
      expectedInformationGain: next.assessment.expectedInformationGain,
      priorEntropy: folded.priorEntropy,
      observation: observation.value,
      posteriorEntropy: folded.predictedPosteriorEntropy,
      costUnits: next.diagnostic.costUnits,
      considered: consideredFrom(next.ranked),
    });
  }
}

// ---------------------------------------------------------------------------
// The argument a point estimate cannot participate in.
// ---------------------------------------------------------------------------

title('What a point estimate would do here');

if (degeneracyExhibit) {
  const { incident, prior } = degeneracyExhibit;
  const argmax = Object.entries(prior).sort((a, b) => b[1] - a[1])[0];

  if (argmax) {
    const collapsed: Record<string, number> = {};
    for (const option of Object.keys(prior)) collapsed[option] = option === argmax[0] ? 1 : 0;

    const withDistribution = assessApplicable(prior, incident, { probesRun: 0, costSpent: 0 }, []);
    const withPointMass = assessApplicable(
      collapsed,
      incident,
      { probesRun: 0, costSpent: 0 },
      [],
    );

    console.log(
      dim(
        `${incident.id}'s real first judgement, and the same judgement collapsed to its argmax\n` +
          `(${argmax[0]} at 100%) — which is all a point-estimate model would have returned.`,
      ),
    );

    console.log(`\n  ${bold('distribution')}  ${dim(`H = ${entropy(Object.values(prior)).toFixed(3)} nats`)}`);
    probeTable(withDistribution.affordable, withDistribution.unaffordable, null);

    console.log(
      `\n  ${bold('point estimate')}  ${dim(`H = ${entropy(Object.values(collapsed)).toFixed(3)} nats · eigIsDegenerate = ${eigIsDegenerate(collapsed)}`)}`,
    );
    probeTable(withPointMass.affordable, withPointMass.unaffordable, null);

    console.log(
      note([
        'Every gain is 0.000, and that is arithmetic rather than tuning: H(point mass) = 0, and',
        'the posterior under any observation is the same point mass, so every term of',
        'H(prior) - E[H(posterior)] is zero for every diagnostic.',
        '',
        'An argmax model does not find this selection harder. It finds every diagnostic equally',
        'worthless, with nothing left to break the tie, because the quantity being compared is',
        'identically zero. The distribution is not a nicer interface onto the same decision —',
        'it is the only thing that makes the decision exist.',
      ]),
    );
  }
}

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------

title('Summary');

const order: Route[] = [
  'deterministic_runbook',
  'linked_to_predecessor',
  'scheduler_retry',
  'suppressed_duplicate',
  'freeze_downstream',
  'act',
  'rolled_back',
  'inconsistent',
  'refused',
];
for (const route of order) {
  const count = routeCounts.get(route) ?? 0;
  if (count === 0) continue;
  console.log(
    `  ${ROUTE_STYLE[route](route.toUpperCase().replace(/_/g, ' ').padEnd(22))} ${String(count).padStart(2)}`,
  );
}

const DETERMINISTIC_ROUTES: readonly Route[] = [
  'deterministic_runbook',
  'linked_to_predecessor',
  'scheduler_retry',
  'suppressed_duplicate',
  'freeze_downstream',
];
const settledByLookup = DETERMINISTIC_ROUTES.reduce(
  (total, route) => total + (routeCounts.get(route) ?? 0),
  0,
);

console.log(
  dim(
    `\n  ${INCIDENTS.length} incidents · ${settledByLookup} settled by lookups before any request was built` +
      `\n  ${requestsMade} request(s) to ${activeBackend() === 'local' ? 'local Laya (not Jev)' : 'Jev'} across ${INCIDENTS.length - settledByLookup} residual incident(s)` +
      `\n  ${probesRunTotal} diagnostic(s) run costing ${probeCostTotal} authored cost unit(s)` +
      '\n  zero incidents routed to a person: every outcome above is a machine action or a refusal',
  ),
);

const authored = Object.entries(DIAGNOSTIC_OBSERVATION_SOURCE).filter(
  ([, source]) => source === 'authored',
).length;

title('What this run does and does not show');
console.log(
  note(
    [
      'Shown: that a distribution over remediations can select a read-only diagnostic by expected',
      'information gain, that ranking on gain-per-cost can pick a different diagnostic than',
      'ranking on gain alone, that an observation can change which remediation leads, that a',
      'spent budget produces a refusal rather than a deferral, and that a failed verification',
      'rolls back in reverse order. That control flow is real and the entropy arithmetic over',
      'the inputs is real.',
      '',
      `Not shown: anything about the inputs. ${authored} of the ${authored + 1} diagnostics return an observation`,
      'a fixture author wrote; only DG-UPSTREAM-DEPGRAPH computes its answer, by walking the',
      'flow snapshot. The diagnostics are not the ones a real SRE team runs, and their costs are',
      'invented units, not measured times. The Bayesian posterior is a prediction under those',
      'authored partitions, not the measured entropy of the next Jev response.',
      live
        ? 'Jev distributions in this run are live measurements on synthetic incidents, not accuracy evidence.'
        : 'Offline distributions and partitions have the same author; agreement is not corroboration.',
      '',
      'Probe selection is greedy: one step of lookahead, no planning over sequences. Fewer probes',
      'here means fewer probes against these fixtures, and nothing about a real incident',
      'population. Redaction runs before anything is sent and is pattern-based, so vendor log',
      'text matching no configured pattern survives into the request.',
    ],
    2,
  ),
);

const lastEntry = ledger.entries().at(-1);
if (lastEntry) console.log(dim(`\n${summarize(lastEntry)}`));
console.log(dim(`ledger: ${ledger.entries().length} decision record(s)`));
