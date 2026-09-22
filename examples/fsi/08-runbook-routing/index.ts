/**
 * 08 — Residual incident runbook routing.
 *
 * An overnight batch window produces thirteen incidents. Deterministic sources
 * answer most of them: the scheduler's dependency graph, the incident system's
 * open alerts, the restart policy, the reconciliation control and the abend
 * mapping table. What is left is the **residual** — incidents where several
 * diagnostic procedures genuinely apply and nothing authoritative decides
 * between them. Only those reach Jev, and only as a bounded Choice over a
 * catalog derived from the affected configuration items, plus `none-of-these`.
 *
 * Application code then turns the returned distribution into a route, and the
 * default route is the ordinary operations queue: where these incidents went
 * before any of this existed.
 *
 * ## Claim contract (docs/CLAIM-CONTRACTS.md, Example 08)
 *
 * May claim:
 * - Known structured mappings and dependency conditions are resolved
 *   deterministically first.
 * - Jev receives only a controlled catalog of candidate runbooks plus `none`.
 * - The application routes ambiguous or split distributions to the ordinary
 *   operations queue.
 * - The safe fallback does not depend on Jev returning a correct answer.
 * - Log preprocessing extracts bounded diagnostic windows and deterministically
 *   redacts the configured fields, before anything is sent. Redaction is
 *   pattern-based: content matching no configured pattern survives into the
 *   request.
 * - Scripted fixtures exercise confident, ambiguous, malformed-response, timeout
 *   and fallback paths.
 * - The ledger distinguishes the recommendation from the route actually taken.
 * - The example demonstrates bounded residual routing control flow.
 *
 * Must not claim: that Jev identifies root cause; that it understands abend
 * codes or spool output; that it selects the *correct* runbook; that the
 * probabilities are calibrated; that the pattern reduces MTTR, paging volume or
 * misrouting; that the catalog or CMDB is complete or current; that a recent
 * deployment caused anything; that a log tail is sufficient evidence; that this
 * is safe to automate without task-specific validation; or that an offline run
 * demonstrates live reliability, cost or latency.
 *
 * Run:  npm run fsi:08
 */

import { VERSION, choice, noul } from '@typesafe-ai/sdk';
import { APIConnectionError } from '@typesafe-ai/sdk';
import { fixtureBanner, fixtureTag, runMode } from '../../../src/fixture-label.ts';
import { createLedger, hashState, metricsFor, stateReference, summarize } from '../../../src/ledger.ts';
import type { DecisionInput } from '../../../src/ledger.ts';
import { diagnosticWindow, redactionSummary } from '../../../src/log-redact.ts';
import {
  CATALOG_VERSION,
  CMDB,
  NONE_OPTION,
  RUNBOOKS_BY_ID,
  assignment,
  candidateCriteria,
  candidateRunbooks,
  preconditionsHold,
} from '../../../src/runbook-catalog.ts';
import { bold, cyan, dim, green, red, title, yellow } from '../../../src/ui.ts';
import { resolveDeterministically } from './deterministic.ts';
import { INCIDENTS } from './fixtures.ts';
import type { Incident } from './fixtures.ts';
import { POLICY_VERSION, THRESHOLDS, decide, fallbackFor } from './policy.ts';
import type { Route } from './policy.ts';
import { routingClient } from './transport.ts';

// The disclosure prints before anything else, on every run.
const live = Boolean(process.env['TYPESAFE_API_KEY']) && process.env['JEV_MOCK'] !== '1';
fixtureBanner(live);

const ledger = createLedger({
  component: '08-runbook-routing',
  mode: runMode(live),
  file: process.env['JEV_LEDGER_FILE'],
  service: { model: 'unknown', sdkPackage: '@typesafe-ai/sdk', sdkVersion: VERSION },
});

/**
 * Fields deliberately kept out of every request.
 *
 * `cmdbOwner` and `pagingRota` are the interesting entries: ownership is
 * metadata, so the model is never shown it and can never be said to have chosen
 * it. `releaseTrain` is withheld for a different reason — offering a recent
 * deployment alongside a failure invites a causal reading that the evidence does
 * not support.
 */
const WITHHELD = [
  'rawSpool',
  'accountAndCardIdentifiers',
  'redactionMapping',
  'cmdbOwner',
  'pagingRota',
  'releaseTrain',
  'customerRecords',
] as const;

const ROUTE_STYLE: Record<Route, (text: string) => string> = {
  deterministic_runbook: green,
  linked_to_predecessor: dim,
  scheduler_retry: dim,
  suppressed_duplicate: dim,
  freeze_downstream: red,
  runbook_suggested: cyan,
  ops_queue: yellow,
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

  const first = answers['first_runbook'];
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
      dim(`flow=${incident.flow} · CIs=${cis} · scheduler=${incident.scheduler.state}` +
        (incident.abendCode ? ` · abend=${incident.abendCode}` : '') +
        (incident.scheduler.slaAt ? ` · SLA ${incident.scheduler.slaAt.slice(11)}` : '')),
  );
}

function routeLine(route: Route, detail: string): void {
  console.log(`  ${ROUTE_STYLE[route](route.toUpperCase().replace(/_/g, ' '))}  ${detail}`);
}

title('08 — Residual incident runbook routing');
console.log(
  dim(
    `${INCIDENTS.length} incidents from one overnight window. Deterministic sources run first;\n` +
      'only what they cannot settle is put to Jev, as a bounded choice over applicable procedures.',
  ),
);

let requestsMade = 0;
const routeCounts = new Map<Route, number>();

for (const incident of INCIDENTS) {
  header(incident);

  // -------------------------------------------------------------------------
  // Stage 1: the lookups.
  // -------------------------------------------------------------------------
  const outcome = resolveDeterministically(incident);

  if (outcome.resolved) {
    routeLine(outcome.route, `${outcome.action} — ${outcome.reason}`);
    console.log(
      `  ${dim(`source: ${outcome.source}@${outcome.sourceVersion} · no request built · spool never left the process`)}`,
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
  const candidates = candidateRunbooks(incident.components);
  const criteria = candidateCriteria(candidates);
  const offered = Object.keys(criteria);

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
    // Carried as untrusted input and labelled as such: it is free text typed by
    // a person on a bridge call, and instructions inside it are not commands.
    operatorNote: incident.operatorNote
      ? { untrustedText: incident.operatorNote, treatAsData: true }
      : null,
    candidateRunbooks: candidates.map((runbook) => ({
      id: runbook.id,
      title: runbook.title,
      firstStep: runbook.firstStep,
    })),
  };

  console.log(
    `  ${dim(
      `window: lines ${window.startLine}–${window.endLine} of ${window.sourceLineCount} · ` +
        `redaction: ${redactionSummary(window.redaction)}`,
    )}`,
  );
  for (const line of window.lines.slice(0, 3)) console.log(`    ${dim(line)}`);
  if (window.lines.length > 3) console.log(`    ${dim(`… ${window.lines.length - 3} more line(s)`)}`);
  console.log(
    `  ${dim(`candidates: ${candidates.length} applicable procedure(s) + ${NONE_OPTION} · withheld: ${WITHHELD.join(', ')}`)}`,
  );

  // -------------------------------------------------------------------------
  // Stage 3: one bounded request.
  // -------------------------------------------------------------------------
  const scripted = incident.scripted;
  const { client } = routingClient(
    () =>
      scripted
        ? {
            first_runbook: { choice: scripted.runbook, strength: scripted.strength },
            evidence_sufficient: { noul: scripted.evidenceSufficient },
          }
        : {},
    incident.fault,
  );

  const questions = {
    first_runbook: choice(
      'Which of these diagnostic procedures should the on-call engineer work through first, ' +
        'given only the evidence supplied? Choose none-of-these if the evidence does not ' +
        'distinguish between them or no listed procedure fits.',
      criteria,
    ),
    evidence_sufficient: noul(
      'Does the supplied diagnostic window contain enough information to distinguish between ' +
        'the listed procedures?',
      {
        true: 'The window identifies a condition matching one listed procedure',
        false: 'The window is truncated, ambiguous, or consistent with several procedures',
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

  const candidateProvenance = {
    source: 'runbook-catalog',
    version: CATALOG_VERSION,
    optionIds: offered,
    readAt: new Date().toISOString(),
  };

  const baseRecord = {
    service: {
      model: response.ok ? response.result.model : 'unknown',
      sdkPackage: '@typesafe-ai/sdk',
      sdkVersion: VERSION,
    },
    state: stateReference(state, [...WITHHELD]),
    candidates: candidateProvenance,
    latencyMs,
  };

  // --- Failure paths. A call that cannot answer is not an answer. -----------
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

    const decision = fallbackFor(kind);
    const team = assignment(incident.components);

    routeLine(decision.route, `${decision.reason}`);
    console.log(`  ${dim(`${kind}: ${detail} (${latencyMs}ms) · assigned ${team.team}`)}`);
    for (const note of team.notes) console.log(`  ${dim(`ownership: ${note}`)}`);

    ledger.record({
      ...baseRecord,
      policy: {
        policyVersion: POLICY_VERSION,
        thresholds: THRESHOLDS,
        route: decision.route,
        reason: decision.reason,
      },
      executed: {
        action: 'ops_queue',
        arguments: { assignedTeam: team.team, incident: incident.id },
      },
      failure: { kind, detail, fallback: 'ordinary operations queue, no procedure suggested' },
    } satisfies DecisionInput);

    routeCounts.set(decision.route, (routeCounts.get(decision.route) ?? 0) + 1);
    continue;
  }

  // -------------------------------------------------------------------------
  // Stage 4: policy over the distribution, then revalidation against state.
  // -------------------------------------------------------------------------
  const metrics = metricsFor(checked.probabilities, checked.choice, offered);
  const isNone = checked.choice === NONE_OPTION;
  const recommended = RUNBOOKS_BY_ID.get(checked.choice);
  const precondition =
    recommended === undefined
      ? { holds: true }
      : preconditionsHold(recommended, incident.components);

  const decision = decide({
    choice: checked.choice,
    metrics,
    evidenceSufficient: checked.evidenceSufficient,
    isNoneOption: isNone,
    precondition,
  });

  const ranked = Object.entries(checked.probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  console.log(
    `  ${dim(
      `distribution: ${ranked.map(([option, p]) => `${option} ${(p * 100).toFixed(1)}%`).join(' · ')}` +
        ` · margin ${metrics.margin.toFixed(2)} · entropy ${metrics.normalizedEntropy.toFixed(2)}` +
        ` · sufficiency ${(checked.evidenceSufficient * 100).toFixed(0)}%`,
    )}`,
  );

  const team = assignment(incident.components);
  // The ledger derives divergence by comparing `recommendation.choice` against
  // `executed.action`, so the executed action has to live in the same namespace
  // as the option IDs. The assigned team is an argument of the action, not part
  // of its identity.
  const executedAction = decision.route === 'runbook_suggested' ? checked.choice : 'ops_queue';

  routeLine(decision.route, decision.reason);
  for (const failure of decision.failed) console.log(`    ${dim(`✗ ${failure}`)}`);
  for (const note of team.notes) console.log(`  ${dim(`ownership: ${note}`)}`);
  if (incident.release) {
    console.log(
      `  ${dim(
        `release ${incident.release.train} touched ${incident.release.components.join(', ')} at ` +
          `${incident.release.deployedAt} — recorded as correlation, withheld from the request, not treated as cause`,
      )}`,
    );
  }

  const diverged = decision.route !== 'runbook_suggested';
  if (diverged) {
    console.log(
      `  ${dim(`recommendation ${checked.choice} recorded but not acted on — ledger marks the divergence`)}`,
    );
  }

  ledger.record({
    ...baseRecord,
    recommendation: {
      question: 'first_runbook',
      choice: checked.choice,
      probabilities: checked.probabilities,
      confidence: checked.confidence,
    },
    metrics,
    policy: {
      policyVersion: POLICY_VERSION,
      thresholds: THRESHOLDS,
      route: decision.route,
      reason: decision.reason,
    },
    executed: {
      action: executedAction,
      arguments: { assignedTeam: team.team, incident: incident.id },
    },
  } satisfies DecisionInput);

  routeCounts.set(decision.route, (routeCounts.get(decision.route) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
title('Where the incidents went');

const deterministicRoutes: Route[] = [
  'deterministic_runbook',
  'linked_to_predecessor',
  'scheduler_retry',
  'suppressed_duplicate',
  'freeze_downstream',
];
const resolvedWithoutModel = deterministicRoutes.reduce(
  (sum, route) => sum + (routeCounts.get(route) ?? 0),
  0,
);

for (const [route, count] of [...routeCounts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${ROUTE_STYLE[route](route.padEnd(22))} ${String(count).padStart(2)}`);
}
console.log(
  `\n  ${bold(`${resolvedWithoutModel} of ${INCIDENTS.length}`)} resolved before any request was built; ` +
    `${requestsMade} request(s) made.`,
);
console.log(
  `  ${dim(
    `${routeCounts.get('runbook_suggested') ?? 0} incident(s) reached a suggested procedure; ` +
      `every other residual incident went to the ordinary queue.`,
  )}`,
);

title('Ledger');
console.log(dim('one record per decision; recommendation and executed action are separate fields'));
for (const entry of ledger.entries()) console.log(`  ${summarize(entry)}`);
console.log(
  `\n  ${dim(
    process.env['JEV_LEDGER_FILE']
      ? `written to ${process.env['JEV_LEDGER_FILE']}`
      : 'set JEV_LEDGER_FILE to append these records as JSONL',
  )}`,
);

// ---------------------------------------------------------------------------
title('What this run did and did not show');
console.log(
  dim(
    'Showed : lookups answering first; a bounded option set built from affected CIs;\n' +
      '         a redacted, anchored window instead of a log tail; split mass and\n' +
      '         none-of-these routed to the ordinary queue; timeout and malformed\n' +
      '         responses routed to the ordinary queue; a confident recommendation\n' +
      '         refused because its preconditions did not hold in authoritative state.\n\n' +
      'Did not : establish that Jev understands abend codes or spool output, that it\n' +
      '         identifies cause, that it picks the correct procedure, or that the\n' +
      '         probabilities mean anything. INC-4480 is the case that matters: a\n' +
      '         peaked distribution pointing at the wrong procedure passes every\n' +
      '         threshold in this file. No flatness test catches a confident error —\n' +
      '         only the revalidation against authoritative state did, and it only\n' +
      '         works where such a check exists.\n\n' +
      `Mode   : ${fixtureTag(live)}`,
  ),
);
console.log(
  dim(
    `\nThresholds (${POLICY_VERSION}) are illustrative: ` +
      Object.entries(THRESHOLDS)
        .map(([name, value]) => `${name}=${value}`)
        .join(', ') +
      `.\nThey are not valid across a different candidate-set size; ${CMDB['FXFEED'].component} in these\n` +
      'fixtures also carries contested CMDB ownership, which the routing surfaces rather than resolves.',
  ),
);
