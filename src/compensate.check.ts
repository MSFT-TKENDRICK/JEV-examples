/**
 * Checks for src/compensate.ts.
 *
 * This module is what replaced the human approval gate, so its guarantees are
 * worth pinning down — particularly the ones about irreversible steps, where
 * being wrong means claiming a rollback that cannot happen.
 */

import { runPlan, validatePlan, type Step } from './compensate.ts';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    failures++;
    console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

interface World {
  log: string[];
  /** Flipped by a test to make a specific step's verification fail. */
  breakVerify?: string;
  breakAct?: string;
  breakCompensate?: string;
}

function reversible(id: string): Step<World> {
  return {
    id,
    description: id,
    reversible: true,
    act: (world) => {
      if (world.breakAct === id) throw new Error(`${id} exploded`);
      world.log.push(`act:${id}`);
    },
    verify: (world) => ({
      ok: world.breakVerify !== id,
      detail: world.breakVerify === id ? `${id} did not take` : `${id} confirmed`,
    }),
    compensate: (world) => {
      if (world.breakCompensate === id) throw new Error(`${id} could not be undone`);
      world.log.push(`undo:${id}`);
    },
  };
}

function irreversible(id: string): Step<World> {
  return {
    id,
    description: id,
    reversible: false,
    act: (world) => {
      world.log.push(`act:${id}`);
    },
    verify: (world) => ({
      ok: world.breakVerify !== id,
      detail: world.breakVerify === id ? `${id} could not be confirmed` : `${id} confirmed`,
    }),
  };
}

async function main(): Promise<void> {
  // --- plan shape ------------------------------------------------------------

  check(
    'a reversible step without compensate() is rejected',
    validatePlan<World>([
      { id: 'a', description: 'a', reversible: true, act: () => {}, verify: () => ({ ok: true, detail: '' }) },
    ]).some((problem) => problem.includes('supplies no compensate')),
  );

  check(
    'an irreversible step that supplies compensate() is rejected',
    validatePlan<World>([
      {
        id: 'a',
        description: 'a',
        reversible: false,
        act: () => {},
        verify: () => ({ ok: true, detail: '' }),
        compensate: () => {},
      },
    ]).some((problem) => problem.includes('would never be called')),
  );

  check(
    'an irreversible step followed by more work is rejected',
    validatePlan([irreversible('commit'), reversible('after')]).some((problem) =>
      problem.includes('must be last'),
    ),
    'this is the ordering guarantee the whole module rests on',
  );

  check(
    'two irreversible steps are rejected',
    validatePlan([irreversible('one'), irreversible('two')]).some((problem) =>
      problem.includes('at most one irreversible'),
    ),
  );

  check('duplicate ids are rejected', validatePlan([reversible('a'), reversible('a')]).length > 0);
  check(
    'a well-formed plan validates',
    validatePlan([reversible('a'), reversible('b'), irreversible('commit')]).length === 0,
  );

  const refused = await runPlan([irreversible('commit'), reversible('after')], { log: [] });
  check('an invalid plan refuses without acting', refused.outcome === 'refused');
  check('refusing runs nothing at all', refused.steps.length === 0);

  // --- the happy path --------------------------------------------------------

  const world: World = { log: [] };
  const completed = await runPlan([reversible('a'), reversible('b'), irreversible('commit')], world);
  check('a good plan completes', completed.outcome === 'completed');
  check(
    'steps run in order, commit last',
    world.log.join(',') === 'act:a,act:b,act:commit',
  );
  check('every step is recorded as verified', completed.steps.every((step) => step.verified));

  // --- rollback --------------------------------------------------------------

  const failsLate: World = { log: [], breakVerify: 'b' };
  const rolled = await runPlan([reversible('a'), reversible('b'), irreversible('commit')], failsLate);
  check('a failed verification rolls back', rolled.outcome === 'rolled_back');
  check(
    'rollback runs in reverse and undoes the failed step too',
    failsLate.log.join(',') === 'act:a,act:b,undo:b,undo:a',
  );
  check('the point of no return is never reached', !failsLate.log.includes('act:commit'));
  check('the rollback reason names the failing step', rolled.reason.includes('"b"'));

  const throwsOnAct: World = { log: [], breakAct: 'b' };
  const afterThrow = await runPlan([reversible('a'), reversible('b')], throwsOnAct);
  check('a step that throws rolls back', afterThrow.outcome === 'rolled_back');
  check(
    'a step that never acted is not compensated',
    throwsOnAct.log.join(',') === 'act:a,undo:a',
  );

  // --- preflight -------------------------------------------------------------

  const preflighted: World = { log: [] };
  const blocked = await runPlan(
    [
      reversible('a'),
      { ...reversible('b'), preflight: () => ({ ok: false, detail: 'account is frozen' }) },
    ],
    preflighted,
  );
  check('a failing preflight refuses the plan', blocked.outcome === 'refused');
  check('preflight refusal explains itself', blocked.reason.includes('account is frozen'));
  check(
    'preflight runs before any step acts, so nothing is left behind',
    preflighted.log.length === 0,
    'a late preflight failure would otherwise strand the earlier steps',
  );

  // --- inconsistency, reported rather than swallowed -------------------------

  const cannotUndo: World = { log: [], breakVerify: 'b', breakCompensate: 'a' };
  const stuck = await runPlan([reversible('a'), reversible('b')], cannotUndo);
  check('a failed compensation reports inconsistent', stuck.outcome === 'inconsistent');
  check('the inconsistent step is named', stuck.inconsistentAt === 'a');
  check(
    'the failed compensation is recorded on the step',
    stuck.steps.find((step) => step.id === 'a')?.compensationError?.includes('could not be undone') === true,
  );

  const badCommit: World = { log: [], breakVerify: 'commit' };
  const unverifiable = await runPlan([reversible('a'), irreversible('commit')], badCommit);
  check(
    'an unverifiable irreversible step is inconsistent, not rolled back',
    unverifiable.outcome === 'inconsistent',
    'claiming a rollback here would be a lie — the commit already happened',
  );
  check('the unverifiable commit is named', unverifiable.inconsistentAt === 'commit');
  check(
    'no compensation is attempted for it',
    !badCommit.log.includes('undo:commit'),
  );

  // --- nothing in this module consults a person ------------------------------

  const outcomes = new Set(
    [refused, completed, rolled, afterThrow, blocked, stuck, unverifiable].map((r) => r.outcome),
  );
  check(
    'no outcome is a handoff to a person',
    !['approval_required', 'escalated', 'queued'].some((banned) => outcomes.has(banned as never)),
  );

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  if (failures > 0) process.exitCode = 1;
}

await main();
