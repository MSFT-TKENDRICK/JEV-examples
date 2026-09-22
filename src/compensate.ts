/**
 * Act, verify, compensate.
 *
 * This file exists because of a question the examples used to answer badly.
 * When a model is uncertain about a consequential action, the tempting design
 * is to stop and ask a person. That is a bad showcase and, more importantly, it
 * is usually not the real engineering answer — it converts an automation
 * problem into a queue, and a reviewer looking at a preselected suggestion
 * under time pressure is a weak control.
 *
 * The real answer is structural. Order the plan so that everything reversible
 * and everything checkable happens first, and the single irreversible step —
 * the point of no return — runs last, only once the preceding work has been
 * performed and verified. Then uncertainty does not need a person: it needs
 * more verified steps before the commit, and a rollback path if verification
 * fails.
 *
 * What this file deliberately does not pretend:
 *
 * - Compensation is not time travel. Undoing a write is not the same as it
 *   never having happened, and some effects (a sent message, a settled
 *   payment) have no inverse at all. Steps declare their own reversibility and
 *   the runner refuses to plan around a claim the step did not make.
 * - Compensation can itself fail. When it does, the system is in a state
 *   neither intended nor undone. That is reported as `inconsistent`, which is a
 *   loud terminal failure and not a synonym for "handled".
 *
 * There is no npm dependency here because the published saga libraries assume a
 * broker or a database transaction manager. This is ~150 lines of ordering and
 * bookkeeping over whatever the caller's steps already do.
 */

/** Why a plan stopped. */
export type Outcome =
  | 'completed'
  | 'rolled_back'
  | 'inconsistent'
  | 'refused'
  | 'aborted_before_commit';

export interface VerifyResult {
  ok: boolean;
  detail: string;
}

export interface Step<Context> {
  id: string;
  description: string;
  /**
   * Whether this step can be undone. A step that says `false` is a point of no
   * return and the runner will refuse to schedule anything irreversible before
   * it has finished verifying everything else.
   */
  reversible: boolean;
  /** Runs before anything executes. Returning false refuses the whole plan. */
  preflight?: (context: Context) => Promise<VerifyResult> | VerifyResult;
  act: (context: Context) => Promise<void> | void;
  /** Confirms the step actually did what it claimed, by reading the world back. */
  verify: (context: Context) => Promise<VerifyResult> | VerifyResult;
  /** Required for reversible steps; never called for irreversible ones. */
  compensate?: (context: Context) => Promise<void> | void;
}

export interface StepRecord {
  id: string;
  acted: boolean;
  verified: boolean;
  detail: string;
  compensated?: boolean;
  compensationError?: string;
}

export interface PlanResult {
  outcome: Outcome;
  reason: string;
  steps: StepRecord[];
  /** Set when compensation failed and the world is in an unintended state. */
  inconsistentAt?: string;
}

/**
 * Rejects plans whose shape makes the guarantees unachievable, before anything
 * runs. Cheap to check and much easier to reason about than discovering it
 * halfway through.
 */
export function validatePlan<Context>(steps: readonly Step<Context>[]): string[] {
  const problems: string[] = [];

  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) problems.push(`duplicate step id "${step.id}"`);
    seen.add(step.id);

    if (step.reversible && step.compensate === undefined) {
      problems.push(`step "${step.id}" claims to be reversible but supplies no compensate()`);
    }
    if (!step.reversible && step.compensate !== undefined) {
      problems.push(
        `step "${step.id}" is irreversible but supplies compensate(), which would never be called`,
      );
    }
  }

  const irreversibleSteps = steps.filter((step) => !step.reversible);
  if (irreversibleSteps.length > 1) {
    problems.push(
      `a plan may contain at most one irreversible step, but ${irreversibleSteps.length} are declared ` +
        `(${irreversibleSteps.map((step) => step.id).join(', ')})`,
    );
  }

  const firstIrreversible = steps.findIndex((step) => !step.reversible);
  if (firstIrreversible !== -1) {
    const after = steps.slice(firstIrreversible + 1);
    if (after.length > 0) {
      problems.push(
        `irreversible step "${steps[firstIrreversible]?.id}" is followed by ${after.length} more step(s) ` +
          `(${after.map((s) => s.id).join(', ')}) — an irreversible step must be last, ` +
          'or the plan cannot be rolled back from a later failure',
      );
    }
  }

  return problems;
}

/**
 * Runs a plan.
 *
 * Preflight everything, then act-and-verify each step in order. Any failure
 * before the point of no return rolls back what has been done, in reverse.
 */
export async function runPlan<Context>(
  steps: readonly Step<Context>[],
  context: Context,
): Promise<PlanResult> {
  const problems = validatePlan(steps);
  if (problems.length > 0) {
    return {
      outcome: 'refused',
      reason: `plan is not runnable: ${problems.join('; ')}`,
      steps: [],
    };
  }

  const records: StepRecord[] = [];

  // Preflight runs for every step before any of them acts, so a plan that was
  // never going to work does not leave half its effects behind.
  for (const step of steps) {
    const result = await step.preflight?.(context);
    if (result !== undefined && !result.ok) {
      return {
        outcome: 'refused',
        reason: `preflight failed on "${step.id}": ${result.detail}`,
        steps: [],
      };
    }
  }

  const done: Step<Context>[] = [];

  for (const step of steps) {
    const record: StepRecord = { id: step.id, acted: false, verified: false, detail: '' };
    records.push(record);

    try {
      await step.act(context);
      record.acted = true;
    } catch (error) {
      record.detail = `act threw: ${String(error)}`;
      return rollback(records, done, context, `step "${step.id}" failed to act`);
    }

    let verified: VerifyResult;
    try {
      verified = await step.verify(context);
    } catch (error) {
      verified = { ok: false, detail: `verify threw: ${String(error)}` };
    }

    record.verified = verified.ok;
    record.detail = verified.detail;

    if (!verified.ok) {
      // An irreversible step that fails verification cannot be undone, and
      // nothing after it ran, so there is nothing to roll back to.
      if (!step.reversible) {
        return {
          outcome: 'inconsistent',
          reason: `irreversible step "${step.id}" could not be verified: ${verified.detail}`,
          steps: records,
          inconsistentAt: step.id,
        };
      }
      return rollback(records, [...done, step], context, `step "${step.id}" failed verification`);
    }

    done.push(step);
  }

  return { outcome: 'completed', reason: 'all steps acted and verified', steps: records };
}

async function rollback<Context>(
  records: StepRecord[],
  done: readonly Step<Context>[],
  context: Context,
  reason: string,
): Promise<PlanResult> {
  for (const step of [...done].reverse()) {
    const record = records.find((entry) => entry.id === step.id);
    if (record === undefined || !record.acted) continue;

    if (!step.reversible || step.compensate === undefined) {
      if (record !== undefined) record.compensated = false;
      return {
        outcome: 'inconsistent',
        reason: `${reason}, and "${step.id}" cannot be undone`,
        steps: records,
        inconsistentAt: step.id,
      };
    }

    try {
      await step.compensate(context);
      record.compensated = true;
    } catch (error) {
      record.compensated = false;
      record.compensationError = String(error);
      return {
        outcome: 'inconsistent',
        reason: `${reason}, and compensating "${step.id}" also failed`,
        steps: records,
        inconsistentAt: step.id,
      };
    }
  }

  return { outcome: 'rolled_back', reason, steps: records };
}
