/**
 * 03 — Jev inside an agent harness.
 *
 * The single most important thing to understand: Jev is never the harness. It
 * does not call tools, hold state, or drive the loop. It is a decision point
 * that your loop consults.
 *
 * What this example is actually about is a situation tool-calling demos
 * normally arrange to avoid: **co-applicable tools**. Five actions could each
 * plausibly be the right first move on this incident, they are not mutually
 * exclusive, and two of them destroy something. A single answer — "replay the
 * window" — is indistinguishable from "replay the window, but it was nearly a
 * coin flip against rotating the credential", and those two situations call for
 * completely different next moves.
 *
 * So the harness does not treat the top option as the decision. It treats the
 * *shape* of the distribution as the decision:
 *
 *   flat         -> run the read-only probe with the highest expected
 *                   information gain per unit cost, observe, re-judge
 *   concentrated -> commit, through an act/verify/compensate plan in which the
 *                   single irreversible step runs last
 *   still flat when the probe budget runs out -> refuse, having changed nothing
 *
 * No branch consults a person. Refusal is a terminal state of the program, not
 * a handoff: it creates no ticket and assumes no one is watching.
 *
 * The comparison the example exists to draw is printed on every incident. Take
 * the same distribution, collapse it to its argmax — which is all a
 * single-answer interface ever gives you — and every probe's expected
 * information gain becomes exactly zero, because a point mass has zero entropy
 * and its posterior under any observation is itself. An argmax does not merely
 * make probe selection harder. It supplies no basis for choosing what to look
 * at first at all.
 *
 * ## Claim contract (docs/CLAIM-CONTRACTS.md, architecture contract)
 *
 * May claim:
 * - Given a distribution over candidates and a set of read-only probes, the
 *   application selects the probe with the highest expected reduction in
 *   entropy, and this selection is computed, not scripted.
 * - The probe ranking, the observation and the posterior are recorded, so the
 *   chain from uncertainty to action is inspectable after the fact.
 * - A point estimate makes every probe's expected information gain exactly
 *   zero. This is arithmetic, and `src/information-gain.check.ts` asserts it.
 * - Irreversible steps run last, after reversible ones have been verified, and
 *   the runner rejects any plan that violates this.
 * - A failed compensation is reported as `inconsistent` and is a loud failure.
 * - Tool arguments are bound in a separate, step-specific stage, and an
 *   identifier that does not resolve in the system of record is rejected by
 *   application code regardless of which model proposed it.
 * - The offline run exercises the published SDK code path with manufactured
 *   HTTP responses.
 *
 * Must not claim: that the probe sequence is optimal — it is greedy and
 * one-step-lookahead; that these are the right probes, or that their costs and
 * partitions reflect anything real, because all three are authored by the
 * fixture; that autonomy is safer than human review, or that removing the
 * approval gate removed a risk rather than a demonstration choice; that the
 * entropy drop across a run says anything about Jev's calibration, since the
 * prior was scripted and the posterior is a consequence of the script; or that
 * a generative model cannot probe — it can, and the claim is about what a bare
 * point estimate supplies.
 *
 * Run:  npm run harness
 */

import { choice, noul } from '@typesafe-ai/sdk';
import { backendLabel, createClient, isLiveJev } from '../src/client.ts';
import type { Step } from '../src/compensate.ts';
import { runPlan } from '../src/compensate.ts';
import { fixtureBanner, fixtureTag } from '../src/fixture-label.ts';
import type { Assessment } from '../src/information-gain.ts';
import {
  assess,
  eigIsDegenerate,
  entropy,
  normalizedEntropy,
  posterior,
  selectProbe,
} from '../src/information-gain.ts';
import { NONE_OPTION, TOOL_IDS, toolById, toolCriteria } from '../src/tools/catalog.ts';
import { NO_CANDIDATE, bindArgument, candidateArguments } from '../src/tools/bind.ts';
import { PROBES, cheapestRemaining, runProbe } from '../src/tools/probes.ts';
import { buildPlan, planShape } from '../src/tools/plan.ts';
import type { Triage } from '../src/tools/triage.ts';
import { createTriager, triagerLabel } from '../src/tools/triage.ts';
import type { ProbeFacts, World, WorldSeed } from '../src/tools/world.ts';
import { createWorld } from '../src/tools/world.ts';
import { bars, bold, cyan, dim, green, note, pct, red, title, yellow } from '../src/ui.ts';

// ---------------------------------------------------------------------------
// Policy. Every number here is the application's, not the model's.
// ---------------------------------------------------------------------------

/** Leader mass at or above which the harness stops probing and commits. */
const DECISION_THRESHOLD = 0.72;

/** Minimum expected gain, in nats, worth paying any cost for. */
const MINIMUM_GAIN = 0.05;

/** ...and as a fraction of the prior's entropy, which is the scale-free version. */
const MINIMUM_GAIN_FRACTION = 0.12;

/** Jev's own read on whether the evidence is sufficient must clear this to act. */
const SUFFICIENCY_THRESHOLD = 0.5;

/** Hard ceiling on probe rounds, independent of cost. A loop needs a stop. */
const MAX_ROUNDS = 5;

// ---------------------------------------------------------------------------
// Fixtures.
//
// Everything below this comment is authored: the ticket, the world's observable
// facts, and the distributions used only with JEV_MOCK=1. In the default live
// mode Jev evaluates the incident and observations; these scripts are not used.
// ---------------------------------------------------------------------------

/** A distribution over tool ids, given the observations gathered so far. */
type DistributionScript = (trail: readonly string[]) => {
  distribution: Record<string, number>;
  evidenceSufficient: number;
};

interface Scenario {
  id: string;
  headline: string;
  ticket: string;
  triage: Triage;
  seed: WorldSeed;
  /** Probe spend allowed for this incident, in the probes' own cost units. */
  budget: number;
  judge: DistributionScript;
  /** Which enumerated record Jev selects once a tool has been chosen. */
  argumentPick: string;
}

const FACTS_STALE_CREDENTIAL: ProbeFacts = {
  scheduler_status: 'runs_failing',
  credential_expiry: 'expired',
  worker_pool_health: 'healthy',
  queue_depth: 'empty',
  warehouse_grant_dryrun: 'permission_denied',
};

const FACTS_WEDGED_QUEUE: ProbeFacts = {
  scheduler_status: 'runs_failing',
  credential_expiry: 'valid',
  worker_pool_health: 'healthy',
  queue_depth: 'wedged_head',
  warehouse_grant_dryrun: 'permission_denied',
};

const FACTS_DENIED_GRANT: ProbeFacts = {
  scheduler_status: 'runs_failing',
  credential_expiry: 'valid',
  worker_pool_health: 'healthy',
  queue_depth: 'empty',
  warehouse_grant_dryrun: 'permission_denied',
};

const FACTS_PAUSED_SCHEDULE: ProbeFacts = {
  scheduler_status: 'schedule_paused',
  credential_expiry: 'valid',
  worker_pool_health: 'healthy',
  queue_depth: 'empty',
  warehouse_grant_dryrun: 'write_ok',
};

const SCENARIOS: readonly Scenario[] = [
  {
    id: 'stale-credentials',
    headline: 'the probe changes which tool wins',
    ticket:
      'Our nightly export to the warehouse has not landed for two days. Nothing changed on our side.',
    triage: {
      summary: 'Nightly warehouse export has produced nothing for two consecutive nights.',
      suggestedRecordId: '',
    },
    seed: {
      incident: 'nightly export has not landed for two nights',
      facts: FACTS_STALE_CREDENTIAL,
      outcomes: { replayRowCount: 41822, newCredentialAuthenticates: true },
    },
    budget: 5,
    argumentPick: 'cred-wh-2025-11',
    judge: (trail) => {
      if (trail.includes('credential_expiry=expired')) {
        return {
          distribution: {
            rotate_export_credential: 0.86,
            reissue_warehouse_grant: 0.06,
            replay_export_window: 0.04,
            drop_poison_message: 0.02,
            resize_worker_pool: 0.01,
            [NONE_OPTION]: 0.01,
          },
          evidenceSufficient: 0.91,
        };
      }
      if (trail.includes('scheduler_status=runs_failing')) {
        // The flip. `replay_export_window` led the prior and is now fourth,
        // because "the runs are erroring" is not what a skipped window looks
        // like. Nothing was executed to learn this.
        return {
          distribution: {
            rotate_export_credential: 0.37,
            drop_poison_message: 0.27,
            reissue_warehouse_grant: 0.25,
            replay_export_window: 0.07,
            resize_worker_pool: 0.02,
            [NONE_OPTION]: 0.02,
          },
          evidenceSufficient: 0.44,
        };
      }
      return {
        distribution: {
          replay_export_window: 0.3,
          rotate_export_credential: 0.24,
          reissue_warehouse_grant: 0.18,
          resize_worker_pool: 0.14,
          drop_poison_message: 0.1,
          [NONE_OPTION]: 0.04,
        },
        evidenceSufficient: 0.21,
      };
    },
  },
  {
    id: 'wedged-queue',
    headline: 'the probe budget runs out and the harness refuses',
    ticket:
      'Exports stopped. We can see retries on your status page. Please just fix it, we have a board pack due.',
    triage: {
      summary: 'Exports stopped with visible retry activity; customer is time-pressured.',
      suggestedRecordId: '',
    },
    seed: {
      incident: 'exports stopped, retries visible',
      facts: FACTS_WEDGED_QUEUE,
      outcomes: { replayRowCount: 0, newCredentialAuthenticates: true },
    },
    // Deliberately tighter than the others. A budget is a policy choice, and
    // this is what it looks like when the cheap diagnostics are spent and the
    // one that would separate the two survivors costs more than is left.
    budget: 3,
    argumentPick: 'msg-8f21c4',
    judge: (trail) => {
      if (trail.includes('credential_expiry=valid')) {
        return {
          distribution: {
            drop_poison_message: 0.4,
            reissue_warehouse_grant: 0.38,
            replay_export_window: 0.1,
            resize_worker_pool: 0.06,
            rotate_export_credential: 0.03,
            [NONE_OPTION]: 0.03,
          },
          evidenceSufficient: 0.38,
        };
      }
      if (trail.includes('scheduler_status=runs_failing')) {
        return {
          distribution: {
            drop_poison_message: 0.3,
            reissue_warehouse_grant: 0.28,
            rotate_export_credential: 0.26,
            replay_export_window: 0.08,
            resize_worker_pool: 0.05,
            [NONE_OPTION]: 0.03,
          },
          evidenceSufficient: 0.3,
        };
      }
      return {
        distribution: {
          drop_poison_message: 0.26,
          reissue_warehouse_grant: 0.24,
          rotate_export_credential: 0.2,
          replay_export_window: 0.16,
          resize_worker_pool: 0.1,
          [NONE_OPTION]: 0.04,
        },
        evidenceSufficient: 0.18,
      };
    },
  },
  {
    id: 'denied-grant',
    headline: 'a reversible step fails verification and the plan rolls back',
    ticket:
      'Export job is green on your side but our warehouse team says nothing is arriving in the landing schema.',
    triage: {
      summary: 'Export reports success while the destination schema receives no rows.',
      suggestedRecordId: '',
    },
    seed: {
      incident: 'export reports success, warehouse receives nothing',
      facts: FACTS_DENIED_GRANT,
      outcomes: { replayRowCount: 0, newCredentialAuthenticates: true },
      writerGranted: false,
    },
    budget: 5,
    argumentPick: 'warehouse_writer',
    judge: (trail) => {
      if (trail.includes('queue_depth=empty')) {
        return {
          distribution: {
            reissue_warehouse_grant: 0.84,
            rotate_export_credential: 0.06,
            replay_export_window: 0.05,
            drop_poison_message: 0.03,
            resize_worker_pool: 0.01,
            [NONE_OPTION]: 0.01,
          },
          evidenceSufficient: 0.87,
        };
      }
      if (trail.includes('credential_expiry=valid')) {
        return {
          distribution: {
            reissue_warehouse_grant: 0.42,
            drop_poison_message: 0.36,
            replay_export_window: 0.12,
            resize_worker_pool: 0.05,
            rotate_export_credential: 0.03,
            [NONE_OPTION]: 0.02,
          },
          evidenceSufficient: 0.4,
        };
      }
      if (trail.includes('scheduler_status=runs_failing')) {
        return {
          distribution: {
            reissue_warehouse_grant: 0.33,
            rotate_export_credential: 0.3,
            drop_poison_message: 0.26,
            replay_export_window: 0.06,
            resize_worker_pool: 0.03,
            [NONE_OPTION]: 0.02,
          },
          evidenceSufficient: 0.29,
        };
      }
      return {
        distribution: {
          reissue_warehouse_grant: 0.28,
          replay_export_window: 0.24,
          rotate_export_credential: 0.2,
          drop_poison_message: 0.16,
          resize_worker_pool: 0.08,
          [NONE_OPTION]: 0.04,
        },
        evidenceSufficient: 0.2,
      };
    },
  },
  {
    id: 'phantom-run-id',
    headline: 'the argument does not resolve, so nothing runs',
    ticket:
      'The 9th March export never ran. Can you re-run run-2026-03-09-nightly for us this morning?',
    triage: {
      summary: 'Customer reports the 9 March window never ran and asks for a re-run.',
      // Lifted verbatim from the ticket. Well-formed, schema-valid, plausible,
      // and not a record this platform has ever held.
      suggestedRecordId: 'run-2026-03-09-nightly',
    },
    seed: {
      incident: 'customer asks for a named window to be replayed',
      facts: FACTS_PAUSED_SCHEDULE,
      outcomes: { replayRowCount: 0, newCredentialAuthenticates: true },
      // The schedule was paused, so no run record was ever created for the
      // window the customer is asking about.
      exportRuns: [],
      queueMessages: [],
    },
    budget: 5,
    argumentPick: NO_CANDIDATE,
    judge: (trail) => {
      if (trail.includes('scheduler_status=schedule_paused')) {
        return {
          distribution: {
            replay_export_window: 0.88,
            resize_worker_pool: 0.04,
            reissue_warehouse_grant: 0.03,
            rotate_export_credential: 0.03,
            drop_poison_message: 0.01,
            [NONE_OPTION]: 0.01,
          },
          evidenceSufficient: 0.9,
        };
      }
      return {
        distribution: {
          replay_export_window: 0.44,
          resize_worker_pool: 0.2,
          reissue_warehouse_grant: 0.16,
          rotate_export_credential: 0.12,
          drop_poison_message: 0.05,
          [NONE_OPTION]: 0.03,
        },
        evidenceSufficient: 0.31,
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Talking to Jev.
// ---------------------------------------------------------------------------

const OFFERED = [...TOOL_IDS, NONE_OPTION];

/**
 * The first-action question.
 *
 * Note what it does *not* ask. It does not ask "which tool applies", because
 * several of them do, and it does not ask the model to sequence the work. It
 * asks which action the evidence supports running **first**; the chosen action
 * then expands into a multi-step plan in `buildPlan()`. Co-applicability is
 * resolved by the plan, not by forcing a single-choice framing onto a
 * multi-step workflow.
 */
const firstActionQuestions = {
  first_action: choice(
    'Several of these actions could eventually be needed. Based only on the evidence in ' +
      '`observations` and `incident`, which one does the evidence most support running FIRST?',
    toolCriteria(),
  ),
  evidence_sufficient: noul(
    'Is the evidence in `observations` sufficient to commit to a first action, ' +
      'as opposed to needing another diagnostic reading?',
  ),
};

interface Judgement {
  distribution: Record<string, number>;
  leader: string;
  leaderMass: number;
  evidenceSufficient: number;
}

/**
 * Validates a response before anything reads a field off it.
 *
 * The SDK types promise a `choice` and a `probabilities` map; they do not
 * promise the service sent them. An answer naming an option that was never
 * offered is a response-integrity failure, not a recommendation, and a failed
 * or malformed judgement is a refusal — never a default to the leader.
 */
function readJudgement(raw: unknown, offered: readonly string[]): Judgement | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const answers = raw as Record<string, unknown>;

  const action = answers['first_action'];
  if (typeof action !== 'object' || action === null) return null;
  const { choice: selected, probabilities } = action as Record<string, unknown>;
  if (typeof selected !== 'string' || !offered.includes(selected)) return null;
  if (typeof probabilities !== 'object' || probabilities === null) return null;

  const distribution: Record<string, number> = {};
  for (const [option, value] of Object.entries(probabilities as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (!offered.includes(option)) return null;
    distribution[option] = value;
  }
  if (distribution[selected] === undefined) return null;

  const sufficiency = answers['evidence_sufficient'];
  const noulValue =
    typeof sufficiency === 'object' && sufficiency !== null
      ? (sufficiency as Record<string, unknown>)['noul']
      : undefined;

  return {
    distribution,
    leader: selected,
    leaderMass: distribution[selected] ?? 0,
    // A missing sufficiency answer is no evidence of sufficiency, which fails
    // the threshold rather than passing it.
    evidenceSufficient: typeof noulValue === 'number' ? noulValue : 0,
  };
}

async function judgeFirstAction(
  world: Readonly<World>,
  observations: readonly string[],
  script: DistributionScript,
): Promise<Judgement | null> {
  const { client } = createClient(() => {
    const scripted = script(observations);
    return {
      first_action: { distribution: scripted.distribution },
      evidence_sufficient: { noul: scripted.evidenceSufficient },
    };
  });

  try {
    const { answers } = await client.systemOne({
      state: {
        incident: world.incident,
        tenant: world.snapshot.tenantId,
        observations: observations.length > 0 ? [...observations] : ['(none yet)'],
      },
      questions: firstActionQuestions,
    });
    return readJudgement(answers, OFFERED);
  } catch (error) {
    console.error(
      'Jev first-action request failed:', error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
    return null;
  }
}

/**
 * The argument-binding stage: a second request, over a candidate set that only
 * exists once the tool is known.
 */
async function judgeArgument(
  world: Readonly<World>,
  toolId: string,
  candidates: readonly { id: string; criteria: string }[],
  pick: string,
): Promise<string | null> {
  const criteria: Record<string, string> = {};
  for (const candidate of candidates) criteria[candidate.id] = candidate.criteria;
  criteria[NO_CANDIDATE] = 'None of these records is the one this action should be pointed at.';

  const { client } = createClient(() => ({ record: { choice: pick, strength: 0.93 } }));

  try {
    const { answers } = await client.systemOne({
      state: { incident: world.incident, action: toolId, source: world.snapshot.source },
      questions: {
        record: choice(
          `Which record in \`${world.snapshot.source}\` should \`${toolId}\` be pointed at?`,
          criteria,
        ),
      },
    });
    const selected = answers.record?.choice;
    return typeof selected === 'string' ? selected : null;
  } catch (error) {
    console.error(
      'Jev record-selection request failed:', error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Narration helpers.
// ---------------------------------------------------------------------------

function showDistribution(judgement: Judgement, label: string): void {
  console.log(`  ${label}`);
  bars(judgement.distribution, { indent: '    ', limit: 6 });
  const masses = Object.values(judgement.distribution);
  console.log(
    `    ${dim(
      `leader ${judgement.leader} at ${pct(judgement.leaderMass)} · ` +
        `entropy ${entropy(masses).toFixed(3)} nats ` +
        `(${(normalizedEntropy(masses) * 100).toFixed(0)}% of uniform) · ` +
        `evidence_sufficient ${pct(judgement.evidenceSufficient)}`,
    )}`,
  );
}

function showRanking(ranked: readonly Assessment[], affordable: readonly string[]): void {
  for (const assessment of ranked) {
    const marker = affordable.includes(assessment.probe.id) ? ' ' : dim('x');
    console.log(
      `    ${marker} ${assessment.probe.id.padEnd(22)} ` +
        `cost ${assessment.probe.cost}  ` +
        `EIG ${assessment.expectedInformationGain.toFixed(3)} nats  ` +
        dim(`per cost ${assessment.gainPerCost.toFixed(3)}`),
    );
  }
}

/**
 * The comparison the whole example is built to draw.
 *
 * Collapse the distribution to its argmax — which is all a single-answer
 * interface ever hands you — and re-run the identical arithmetic.
 */
function showDegenerateArm(judgement: Judgement, verbose: boolean): void {
  const pointEstimate = { [judgement.leader]: 1 };
  const degenerate = eigIsDegenerate(pointEstimate);
  const assessments = PROBES.map((probe) => assess(pointEstimate, probe));
  const best = Math.max(...assessments.map((entry) => entry.expectedInformationGain));

  console.log(
    `  ${dim('point-estimate arm')} ${bold(`"${judgement.leader}"`)} ${dim('with no distribution:')} ` +
      `eigIsDegenerate=${degenerate} · ` +
      `best EIG over ${PROBES.length} probes = ${best.toFixed(3)} nats`,
  );

  if (!verbose) return;

  for (const assessment of assessments) {
    console.log(
      `    ${assessment.probe.id.padEnd(22)} ` +
        `H(prior) ${assessment.priorEntropy.toFixed(3)}  ` +
        `E[H(posterior)] ${assessment.expectedPosteriorEntropy.toFixed(3)}  ` +
        `EIG ${assessment.expectedInformationGain.toFixed(3)}`,
    );
  }
  console.log(
    note([
      'Zero for every probe, and not by coincidence. A point mass has zero entropy,',
      'and its posterior under any observation is that same point mass, so the',
      'subtraction is 0 - 0 for all five. An argmax-only interface does not make',
      'choosing what to check first harder; it makes every check look identically',
      'worthless, which removes any principled basis for choosing one.',
    ]),
  );
}

// ---------------------------------------------------------------------------
// The cheapest-first comparison arm.
//
// Reported per round and never accumulated, because a running total would be a
// fabrication. Cheapest-first picking a different probe in round n returns a
// different observation, hence a different posterior, hence a different option
// set in round n+1. Only the first divergent step is knowable from a trail that
// policy never produced; everything past it would be invented. Probing is
// path-dependent, which is exactly why probe selection is a sequential problem
// and not a sort.
// ---------------------------------------------------------------------------

interface Divergence {
  incident: string;
  round: number;
  chosen: string;
  naive: string;
  costRatio: number;
  gainRatio: number;
  tiedCost: boolean;
}

const divergences: Divergence[] = [];
let divergenceNoteShown = false;

// ---------------------------------------------------------------------------
// One incident.
// ---------------------------------------------------------------------------

interface IncidentResult {
  id: string;
  leader: string;
  probesRun: string[];
  spend: number;
  outcome: string;
  detail: string;
}

async function runIncident(scenario: Scenario, verboseDegenerate: boolean): Promise<IncidentResult> {
  const world = createWorld(scenario.seed);
  title(live ? scenario.id : `${scenario.id} — ${scenario.headline}`);
  console.log(`  ${dim('ticket:')} ${scenario.ticket}`);

  // The generative half summarizes the ticket; Jev judges the incident and observations.
  const triager = createTriager(scenario.triage);
  const triaged = await triager.triage(scenario.ticket);
  console.log(`  ${dim(`triage (${triagerLabel(triager)}):`)} ${triaged.summary}`);
  if (triaged.suggestedRecordId !== '') {
    console.log(
      `  ${dim('record id lifted from the ticket:')} ${yellow(triaged.suggestedRecordId)}`,
    );
  }

  const observations: string[] = [];
  const probesRun: string[] = [];
  let spend = 0;
  let stopReason = '';

  let judgement = await judgeFirstAction(world, observations, scenario.judge);
  if (judgement === null) {
    console.log(`  ${red('REFUSE')} judgement unavailable or malformed — nothing was changed`);
    console.log(note('A failed judgement is a refusal. It is never a default to the leader.'));
    return {
      id: scenario.id,
      leader: '(none)',
      probesRun,
      spend,
      outcome: 'refused',
      detail: 'judgement unavailable',
    };
  }

  console.log('');
  showDistribution(judgement, `${bold('round 0')} ${dim('· no observations yet')}`);
  showDegenerateArm(judgement, verboseDegenerate);

  // --- The probe loop ------------------------------------------------------
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const selection = selectProbe(judgement.distribution, PROBES, {
      exclude: probesRun,
      decisionThreshold: DECISION_THRESHOLD,
      minimumGain: MINIMUM_GAIN,
      minimumGainFraction: MINIMUM_GAIN_FRACTION,
    });

    if (selection.chosen === null) {
      stopReason = selection.reason;
      break;
    }

    // `selectProbe` ranks on value, not on affordability — budget is the
    // application's concern, so the application walks the ranking for the best
    // probe it can actually pay for.
    const remaining = scenario.budget - spend;
    const affordable = selection.ranked.filter((entry) => entry.probe.cost <= remaining);

    console.log(
      `\n  ${bold(`round ${round}`)} ${dim(`· budget ${remaining} of ${scenario.budget} left`)}`,
    );
    showRanking(
      selection.ranked,
      affordable.map((entry) => entry.probe.id),
    );

    const picked = affordable[0];
    if (picked === undefined) {
      stopReason =
        `probe budget exhausted: ${spend} of ${scenario.budget} spent, and the cheapest ` +
        `probe still worth running (${selection.chosen.probe.id}, cost ` +
        `${selection.chosen.probe.cost}) costs more than the ${remaining} remaining`;
      console.log(`    ${yellow('BUDGET')} ${dim(stopReason)}`);
      break;
    }

    const naive = cheapestRemaining(probesRun);
    const observation = runProbe(world, picked.probe.id);
    spend += picked.probe.cost;
    probesRun.push(picked.probe.id);
    observations.push(`${picked.probe.id}=${observation}`);

    console.log(
      `    ${cyan('PROBE')} ${picked.probe.id} ${dim(`(${picked.probe.description ?? ''})`)}`,
    );
    console.log(
      `      observed ${bold(observation)} ${dim(
        `· cost ${picked.probe.cost} · expected to remove ` +
          `${picked.expectedInformationGain.toFixed(3)} of ${picked.priorEntropy.toFixed(3)} nats`,
      )}`,
    );
    if (naive !== undefined && naive.id !== picked.probe.id) {
      const naiveAssessment = selection.ranked.find((entry) => entry.probe.id === naive.id);
      const naiveGain = naiveAssessment?.expectedInformationGain ?? 0;
      const costRatio = picked.probe.cost / naive.cost;
      const gainRatio = naiveGain > 0 ? picked.expectedInformationGain / naiveGain : Infinity;
      const tiedCost = picked.probe.cost === naive.cost;
      divergences.push({
        incident: scenario.id,
        round,
        chosen: picked.probe.id,
        naive: naive.id,
        costRatio,
        gainRatio,
        tiedCost,
      });
      console.log(
        `      ${dim(
          `cheapest-first would have run ${naive.id} here instead: ` +
            `cost ${naive.cost} vs ${picked.probe.cost} (${costRatio.toFixed(2)}x), ` +
            `EIG ${naiveGain.toFixed(3)} vs ${picked.expectedInformationGain.toFixed(3)} nats ` +
            `(${gainRatio === Infinity ? '∞' : `${gainRatio.toFixed(2)}x`})`,
        )}`,
      );
      if (tiedCost) {
        console.log(
          `      ${dim(
            'the two are the same cost, so "cheapest" is settled here by catalog order — ' +
              'the naive policy has no principle for the tie',
          )}`,
        );
      }
      if (!divergenceNoteShown) {
        divergenceNoteShown = true;
        console.log(
          note(
            [
              'This round only, and deliberately never accumulated. Had cheapest-first',
              'actually run its probe here it would have observed something else, so the',
              'next posterior and the next option set would both differ. Only the first',
              'divergent step is knowable from a trail that policy never generated; a',
              'running "cheapest-first would have spent N by now" total would be invented.',
              'Probing is path-dependent, which is why selecting probes is a sequential',
              'problem and not a sort.',
              '',
              'Note also that ranking is by gain per cost, so the chosen probe beating the',
              'cheapest one on gain per cost is true by construction — a consistency check',
              'on the trail, not a result. The figures worth reading are the cost and',
              'information ratios above, in whichever direction they fall.',
            ],
            6,
          ),
        );
      }
    }

    // What the authored partition predicts, computed by Bayes from the prior.
    const analytic = posterior(judgement.distribution, picked.probe, observation);
    const analyticLeader = Object.entries(analytic).sort((a, b) => b[1] - a[1])[0];

    const before = judgement.leader;
    const next = await judgeFirstAction(world, observations, scenario.judge);
    if (next === null) {
      stopReason = 'judgement unavailable after probing';
      break;
    }
    judgement = next;

    console.log('');
    showDistribution(judgement, `  ${dim('re-judged with the observation in state')}`);
    console.log(
      `    ${dim(
        `the authored partition predicted ${analyticLeader?.[0] ?? '(none)'} at ` +
          `${pct(analyticLeader?.[1])}; the re-judgement is what the loop follows, and ` +
          'agreement between the two is authored, not evidence',
      )}`,
    );
    if (before !== judgement.leader) {
      console.log(
        `    ${green('FLIP')} leader moved ${before} -> ${judgement.leader} ` +
          dim('— the probe changed the answer, and nothing was executed to learn it'),
      );
    }
  }

  // --- Commit, or refuse ---------------------------------------------------
  console.log('');
  const concentrated = judgement.leaderMass >= DECISION_THRESHOLD;
  const sufficient = judgement.evidenceSufficient >= SUFFICIENCY_THRESHOLD;

  if (!concentrated || !sufficient || judgement.leader === NONE_OPTION) {
    const reasons = [
      !concentrated
        ? `leader holds ${pct(judgement.leaderMass)}, below the ${DECISION_THRESHOLD} threshold`
        : null,
      !sufficient
        ? `evidence_sufficient ${pct(judgement.evidenceSufficient)} below ${SUFFICIENCY_THRESHOLD}`
        : null,
      judgement.leader === NONE_OPTION ? 'the evidence fits none of the catalog' : null,
    ].filter((reason): reason is string => reason !== null);

    console.log(`  ${red('REFUSE')} ${reasons.join('; ')}`);
    if (stopReason !== '') console.log(`    ${dim(stopReason)}`);
    console.log(
      note([
        'Terminal. Nothing was executed, no state changed, and no queue item was',
        'created — this is the end of the program for this incident, not a handoff.',
        'Raising the budget would let it keep probing; whether that is the right',
        'policy is a question about this incident class, not about the mechanism.',
      ]),
    );
    return {
      id: scenario.id,
      leader: judgement.leader,
      probesRun,
      spend,
      outcome: 'refused',
      detail: reasons[0] ?? stopReason,
    };
  }

  const tool = toolById(judgement.leader);
  if (tool === undefined) {
    console.log(`  ${red('REFUSE')} "${judgement.leader}" is not in the tool catalog`);
    return {
      id: scenario.id,
      leader: judgement.leader,
      probesRun,
      spend,
      outcome: 'refused',
      detail: 'unknown tool',
    };
  }

  console.log(
    `  ${green('COMMIT')} ${bold(tool.id)} ${dim(`at ${pct(judgement.leaderMass)} — ${tool.summary}`)}`,
  );
  if (stopReason !== '') console.log(`    ${dim(stopReason)}`);

  // --- Argument binding: a separate, step-specific stage --------------------
  const candidates = candidateArguments(world, tool.argument);
  console.log(
    `\n  ${bold('bind')} ${dim(
      `${tool.argument} for ${tool.id} · ${candidates.length} candidate record(s) in ${world.snapshot.source}`,
    )}`,
  );

  // Anything anyone proposed gets checked the same way, including the
  // identifier the generative arm copied out of the customer's prose.
  if (triaged.suggestedRecordId !== '') {
    const fromTicket = bindArgument(world, tool, triaged.suggestedRecordId);
    if (!fromTicket.ok) {
      console.log(`    ${red('REJECTED')} ${triaged.suggestedRecordId} ${dim('(from the ticket)')}`);
      console.log(`      ${dim(fromTicket.reason)}`);
      console.log(
        note([
          'Rejected by bindArgument, in application code, before anything ran. Not',
          'because a generative model proposed it — because it does not resolve in',
          'the system of record. A generative implementation constrained to',
          'enumerated identifiers would pass this check for the same reason.',
        ]),
      );
    }
  }

  if (candidates.length === 0) {
    console.log(
      `  ${red('REFUSE')} no ${tool.argument} in ${world.snapshot.source} for this action`,
    );
    console.log(
      note([
        'Reached without consulting anything further: an action with no authoritative',
        'record to point at cannot be made safe by asking harder.',
      ]),
    );
    return {
      id: scenario.id,
      leader: tool.id,
      probesRun,
      spend,
      outcome: 'refused',
      detail: 'no candidate record',
    };
  }

  const selectedRecord = await judgeArgument(world, tool.id, candidates, scenario.argumentPick);
  if (selectedRecord === null || selectedRecord === NO_CANDIDATE) {
    console.log(`  ${red('REFUSE')} no record selected for ${tool.id}`);
    return {
      id: scenario.id,
      leader: tool.id,
      probesRun,
      spend,
      outcome: 'refused',
      detail: 'no record selected',
    };
  }

  const binding = bindArgument(world, tool, selectedRecord);
  if (!binding.ok) {
    console.log(
      `    ${red('REJECTED')} ${binding.proposed} ${dim('(selected from the candidate set)')}`,
    );
    console.log(`      ${dim(binding.reason)}`);
    return {
      id: scenario.id,
      leader: tool.id,
      probesRun,
      spend,
      outcome: 'refused',
      detail: 'argument did not bind',
    };
  }
  console.log(
    `    ${green('BOUND')} ${binding.kind}=${binding.value} ${dim(`from ${binding.source}`)}`,
  );

  // --- Execute through the act/verify/compensate runner --------------------
  const steps: Step<World>[] = buildPlan(tool, binding.value);
  console.log(`\n  ${bold('plan')}  ${dim(planShape(steps))}`);
  if (tool.hasIrreversibleStep) {
    console.log(
      `    ${dim(
        'the irreversible step is last by construction, and runPlan rejects any plan ' +
          'where it is not',
      )}`,
    );
  }

  const result = await runPlan(steps, world);

  for (const step of result.steps) {
    const status = step.verified ? green('ok') : step.acted ? red('failed') : dim('not run');
    console.log(`    ${status.padEnd(16)} ${step.id.padEnd(22)} ${dim(step.detail)}`);
  }

  const compensated = result.steps.filter((step) => step.compensated === true);
  if (compensated.length > 0) {
  // `result.steps` is in execution order; compensation ran the other way, so
  // this list has to be reversed to report what actually happened.
  console.log(`    ${yellow('compensated, in reverse order:')}`);
  for (const step of [...compensated].reverse()) {
    console.log(`      ${yellow('undo')} ${step.id}`);
  }
    console.log(
      note([
        'Reverse order is not cosmetic. The later steps were built on the earlier',
        'ones, so undoing the grant before undoing the replay would leave the replay',
        'referencing a permission that no longer exists.',
      ]),
    );
  }

  const style =
    result.outcome === 'completed' ? green : result.outcome === 'inconsistent' ? red : yellow;
  console.log(`  ${style(result.outcome.toUpperCase())} ${dim(result.reason)}`);

  if (result.outcome === 'inconsistent') {
    console.log(
      note([
        'A loud failure, not a resolved state. Compensation did not restore the world,',
        'so it is in a state that was neither intended nor undone.',
      ]),
    );
  }
  if (result.outcome === 'rolled_back') {
    console.log(
      note([
        'The world is back where it started and the incident is unresolved. That is a',
        'worse outcome than success and a much better one than a half-applied change.',
      ]),
    );
  }

  return {
    id: scenario.id,
    leader: tool.id,
    probesRun,
    spend,
    outcome: result.outcome,
    detail: result.reason,
  };
}

// ---------------------------------------------------------------------------

const live = isLiveJev();
fixtureBanner(live);

title('03 — uncertainty selects the next machine action');
console.log(
  note(
    [
      'Five co-applicable tools, five read-only probes, one incident at a time.',
      'A flat distribution buys a probe. A concentrated one buys a plan whose',
      'irreversible step runs last. An exhausted budget buys nothing at all.',
      '',
      `run mode: ${fixtureTag(live)}`,
    ],
    2,
  ),
);

const results: IncidentResult[] = [];
for (const [index, scenario] of SCENARIOS.entries()) {
  results.push(await runIncident(scenario, index === 0));
}

title('Summary');
console.log(
  `  ${'incident'.padEnd(18)} ${'leading action'.padEnd(26)} ${'probes'.padEnd(7)}${'spend'.padEnd(7)}outcome`,
);
for (const result of results) {
  const style =
    result.outcome === 'completed' ? green : result.outcome === 'refused' ? red : yellow;
  console.log(
    `  ${result.id.padEnd(18)} ${result.leader.padEnd(26)} ` +
      `${String(result.probesRun.length).padEnd(7)}${String(result.spend).padEnd(7)}` +
      `${style(result.outcome)}`,
  );
}
console.log(
  note(
    [
      '"leading action" is where the distribution ended up, not necessarily what was executed.',
      `${results.filter((result) => result.outcome === 'refused').length} incident(s) refused without executing a plan.`,
    ],
    2,
  ),
);

title('Where cheapest-first would have differed');
const totalRounds = results.reduce((sum, result) => sum + result.probesRun.length, 0);
if (divergences.length === 0) {
  console.log(`  ${dim('no round diverged — cheapest-first would have chosen identically throughout')}`);
} else {
  for (const divergence of divergences) {
    console.log(
      `  ${divergence.incident.padEnd(18)} round ${divergence.round}  ` +
        `${divergence.naive} -> ${divergence.chosen}  ` +
        `${dim(
          `${divergence.costRatio.toFixed(2)}x cost for ` +
            `${divergence.gainRatio === Infinity ? '∞' : `${divergence.gainRatio.toFixed(2)}x`}` +
            ' expected information',
        )}`,
    );
  }
}
console.log(
  note(
    [
      `${divergences.length} of ${totalRounds} probe rounds diverged. Each line is a single round`,
      'evaluated against the posterior that actually held at that round; the rows do not',
      'compose into an alternative run and are not summed for that reason.',
      '',
      'Probe costs and partitions in src/tools/probes.ts are authored assumptions.',
      'These comparisons demonstrate policy arithmetic, not measured diagnostic value.',
    ],
    2,
  ),
);

title('Who decided what');
console.log(
  note(
    [
      'the AI SDK       read the ticket and copied out the identifier in it',
      'Jev              the distribution over first actions, and which record to bind',
      'information-gain which probe to run next, from that distribution — computed',
      'your code        the thresholds, the budget, what binds, what runs, when to refuse',
      'compensate.ts    the ordering guarantee, the verification, the rollback',
      'Jev              executed nothing and held no state between rounds',
      '',
      live
        ? `The distributions above came from live requests to ${backendLabel()}. The probe`
        : 'Every distribution above was manufactured by src/mock-fetch.ts. The probe',
      'costs and partitions were authored in src/tools/probes.ts. The entropy and the',
      'expected-gain arithmetic over them is real. What the run shows is what the',
      'application does with a distribution — never that the distribution is right.',
    ],
    2,
  ),
);
