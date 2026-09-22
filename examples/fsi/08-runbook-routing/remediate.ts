/**
 * Executing a remediation, reversibly.
 *
 * Once the distribution has concentrated, something has to actually happen —
 * and "act" is only a safe answer to uncertainty if acting is undoable. This
 * file turns a catalog `Remediation` into a plan for `src/compensate.ts`, which
 * supplies the guarantees: preflight everything before touching anything, verify
 * each step by reading the world back, roll back in reverse order on failure,
 * and refuse outright any plan that schedules work after a point of no return.
 *
 * ## What is simulated
 *
 * There is no mainframe here. `World` is an in-memory record of what the steps
 * claim to have done, and `verify` reads that record back. So the rollback this
 * example demonstrates is real control flow over a fake world: the ordering,
 * the reverse-order compensation and the `inconsistent` outcome are all produced
 * by `src/compensate.ts` doing its actual job, while what is being ordered and
 * undone is bookkeeping.
 *
 * That distinction matters for what may be claimed. The example shows that a
 * failed verification triggers compensation in the right order. It does not show
 * that any particular mainframe operation is reversible in practice, and whether
 * `undo` is truthful for a given procedure is a question about that procedure,
 * not about this code.
 *
 * ## The failure is scripted on purpose
 *
 * A runner that only ever succeeds has demonstrated nothing about rollback, so
 * one fixture names a step whose verification is scripted to fail. Everything
 * downstream of that — the compensations, the outcome, the ledger record — is
 * ordinary behaviour reacting to it.
 */

import { runPlan, validatePlan, type PlanResult, type Step } from '../../../src/compensate.ts';
import type { Remediation } from '../../../src/runbook-catalog.ts';

/**
 * The simulated world the steps act on.
 *
 * `applied` records step ids that acted and have not been compensated;
 * `journal` is the human-readable trace printed under each remediation.
 */
export interface World {
  incidentId: string;
  applied: Set<string>;
  journal: string[];
  /** Step id whose verification is scripted to fail. */
  failingStep?: string;
}

export function createWorld(incidentId: string, failingStep?: string): World {
  return { incidentId, applied: new Set(), journal: [], failingStep };
}

/**
 * Builds a runnable plan from a catalog remediation.
 *
 * Reversible steps get a `compensate` that removes their effect; the
 * irreversible step, if there is one, deliberately gets none — `validatePlan`
 * rejects a plan that supplies one, on the grounds that a compensation that can
 * never be called is a lie about what the plan can undo.
 */
export function planFor(remediation: Remediation, world: World): Step<World>[] {
  return remediation.plan.map((step) => {
    const base = {
      id: step.id,
      description: step.description,
      reversible: step.reversible,
      preflight: () => ({
        ok: !world.applied.has(step.id),
        detail: world.applied.has(step.id)
          ? `${step.id} is already applied`
          : `${step.id} has not been applied`,
      }),
      act: () => {
        world.applied.add(step.id);
        world.journal.push(`acted   ${step.id}: ${step.description}`);
      },
      verify: () => {
        // The scripted failure. Everything else about this step is ordinary.
        if (world.failingStep === step.id) {
          world.journal.push(`FAILED  ${step.id}: could not confirm ${step.verifies}`);
          return { ok: false, detail: `could not confirm ${step.verifies}` };
        }
        const ok = world.applied.has(step.id);
        world.journal.push(
          ok
            ? `verified ${step.id}: ${step.verifies}`
            : `FAILED  ${step.id}: step did not take effect`,
        );
        return {
          ok,
          detail: ok ? step.verifies : 'step did not take effect',
        };
      },
    };

    if (!step.reversible) return base;

    return {
      ...base,
      compensate: () => {
        world.applied.delete(step.id);
        world.journal.push(`undone  ${step.id}: ${step.undo ?? 'effect removed'}`);
      },
    };
  });
}

export interface RemediationResult {
  result: PlanResult;
  world: World;
  /** Problems found by `validatePlan`, reported before anything ran. */
  problems: readonly string[];
}

/** Validates, then runs. The validation result is surfaced either way. */
export async function remediate(
  remediation: Remediation,
  incidentId: string,
  failingStep?: string,
): Promise<RemediationResult> {
  const world = createWorld(incidentId, failingStep);
  const steps = planFor(remediation, world);
  const problems = validatePlan(steps);
  const result = await runPlan(steps, world);
  return { result, world, problems };
}

/**
 * How many steps verified, for the ledger's `ExecutionRecord`.
 *
 * Counted from the step records rather than assumed from the outcome, so a
 * partially-applied-then-rolled-back run reports what actually happened.
 */
export function stepCounts(result: PlanResult): { attempted: number; verified: number } {
  return {
    attempted: result.steps.filter((step) => step.acted).length,
    verified: result.steps.filter((step) => step.verified).length,
  };
}
