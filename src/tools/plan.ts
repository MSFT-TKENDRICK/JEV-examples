/**
 * Turning a chosen tool into a runnable plan.
 *
 * This is where the co-applicability problem is actually resolved. The Choice
 * asked which action to run *first*, and the answer is not a single API call —
 * it expands into several steps, most of which are reversible, at most one of
 * which is not. `runPlan()` enforces the ordering: the point of no return goes
 * last, after everything before it has acted **and** been verified by reading
 * the world back.
 *
 * So the harness never had to decide "credential rotation or queue drain" as if
 * they were exclusive. It decided what to do first, and the plan carries the
 * rest.
 *
 * Every `verify()` here reads the snapshot rather than trusting the return of
 * `act()`. That distinction is the entire value of the stage: a step that
 * reports success and did not happen is exactly the failure verification is for,
 * and asking the actor whether it succeeded catches none of them.
 */

import type { Step } from '../compensate.ts';
import type { ToolSpec } from './catalog.ts';
import type { ExportRun, World } from './world.ts';
import { activeCredential, credentialById, grantFor, record } from './world.ts';

const ROTATED_SUFFIX = '-rotated';

function exportRun(world: Readonly<World>, id: string): ExportRun | undefined {
  return world.snapshot.exportRuns.find((run) => run.id === id);
}

/** Acts out a replay of one window, using the row count the fixture authored. */
function replayStep(id: string, runId: string): Step<World> {
  let previous: { status: ExportRun['status']; rows: number } | null = null;

  return {
    id,
    description: `replay export window for ${runId}`,
    reversible: true,
    act: (world) => {
      const run = exportRun(world, runId);
      if (run === undefined) throw new Error(`export run ${runId} vanished between plan and act`);
      previous = { status: run.status, rows: run.rows };
      run.rows = world.outcomes.replayRowCount;
      run.status = run.rows > 0 ? 'succeeded' : 'failed';
      record(world, id, `replayed ${runId}, ${run.rows} rows landed`);
    },
    // The check that matters: a replay that ran and moved no rows has not fixed
    // the customer's problem, however cleanly the call returned.
    verify: (world) => {
      const run = exportRun(world, runId);
      if (run === undefined) return { ok: false, detail: `export run ${runId} not found after replay` };
      return run.rows > 0
        ? { ok: true, detail: `${runId} landed ${run.rows} rows` }
        : { ok: false, detail: `${runId} replayed but landed 0 rows — the window is still empty` };
    },
    compensate: (world) => {
      const run = exportRun(world, runId);
      if (run === undefined || previous === null) return;
      run.status = previous.status;
      run.rows = previous.rows;
      record(world, id, `rolled back replay of ${runId}`);
    },
  };
}

/**
 * Builds the plan for one bound tool call.
 *
 * Throws on an unbound argument rather than defaulting, because a plan built
 * around a placeholder identifier is worse than no plan.
 */
export function buildPlan(tool: ToolSpec, argument: string): Step<World>[] {
  switch (tool.id) {
    case 'rotate_export_credential': {
      const newId = `${argument}${ROTATED_SUFFIX}`;
      let previousCredentialId = '';

      return [
        {
          id: 'stage_credential',
          description: `mint ${newId} alongside the current secret, without activating it`,
          reversible: true,
          act: (world) => {
            world.snapshot.credentials.push({
              id: newId,
              label: 'warehouse writer (staged)',
              expiresAt: '2027-03-11T00:00:00.000Z',
              active: false,
            });
            record(world, 'stage_credential', `staged ${newId}`);
          },
          verify: (world) => {
            if (credentialById(world, newId) === undefined) {
              return { ok: false, detail: `${newId} is not in ${world.snapshot.source}` };
            }
            return world.outcomes.newCredentialAuthenticates
              ? { ok: true, detail: `${newId} authenticates against the warehouse` }
              : { ok: false, detail: `${newId} was created but the warehouse rejects it` };
          },
          compensate: (world) => {
            world.snapshot.credentials = world.snapshot.credentials.filter(
              (credential) => credential.id !== newId,
            );
            record(world, 'stage_credential', `deleted staged ${newId}`);
          },
        },
        {
          id: 'repoint_export_job',
          description: `point the export job configuration at ${newId}`,
          reversible: true,
          act: (world) => {
            previousCredentialId = world.snapshot.exportJob.credentialId;
            world.snapshot.exportJob.credentialId = newId;
            record(world, 'repoint_export_job', `job now uses ${newId}`);
          },
          verify: (world) =>
            world.snapshot.exportJob.credentialId === newId
              ? { ok: true, detail: `job configuration reads ${newId}` }
              : { ok: false, detail: 'job configuration did not take the new credential' },
          compensate: (world) => {
            world.snapshot.exportJob.credentialId = previousCredentialId;
            record(world, 'repoint_export_job', `job repointed back at ${previousCredentialId}`);
          },
        },
        {
          // The point of no return. It runs last, and only because the two
          // steps above acted and then verified — the new secret works and the
          // job is already using it.
          id: 'revoke_old_credential',
          description: `revoke ${argument} at the warehouse`,
          reversible: false,
          preflight: (world) => {
            const current = credentialById(world, argument);
            if (current === undefined) {
              return { ok: false, detail: `${argument} is not in ${world.snapshot.source}` };
            }
            return { ok: true, detail: `${argument} present and revocable` };
          },
          act: (world) => {
            const current = credentialById(world, argument);
            if (current !== undefined) current.active = false;
            const staged = credentialById(world, newId);
            if (staged !== undefined) staged.active = true;
            record(world, 'revoke_old_credential', `revoked ${argument}`);
          },
          verify: (world) => {
            const current = credentialById(world, argument);
            return current?.active === false
              ? { ok: true, detail: `${argument} no longer authenticates` }
              : { ok: false, detail: `${argument} still accepts connections` };
          },
        },
      ];
    }

    case 'replay_export_window': {
      let previousStatus: ExportRun['status'] = 'failed';

      return [
        {
          id: 'claim_window',
          description: `claim ${argument} so the scheduler does not race the replay`,
          reversible: true,
          act: (world) => {
            const run = exportRun(world, argument);
            if (run === undefined) throw new Error(`export run ${argument} not found`);
            previousStatus = run.status;
            run.status = 'queued';
            record(world, 'claim_window', `claimed ${argument}`);
          },
          verify: (world) =>
            exportRun(world, argument)?.status === 'queued'
              ? { ok: true, detail: `${argument} is claimed` }
              : { ok: false, detail: `${argument} was not claimed` },
          compensate: (world) => {
            const run = exportRun(world, argument);
            if (run !== undefined) run.status = previousStatus;
            record(world, 'claim_window', `released ${argument}`);
          },
        },
        replayStep('replay_window', argument),
      ];
    }

    case 'resize_worker_pool': {
      let previousCount = 0;
      const target = 6;

      return [
        {
          id: 'scale_pool',
          description: `scale ${argument} up to ${target} workers`,
          reversible: true,
          act: (world) => {
            previousCount = world.snapshot.exportJob.workerCount;
            world.snapshot.exportJob.workerCount = target;
            record(world, 'scale_pool', `${previousCount} -> ${target} workers`);
          },
          verify: (world) =>
            world.snapshot.exportJob.workerCount >= target
              ? { ok: true, detail: `${target} workers registered` }
              : { ok: false, detail: 'worker count did not change' },
          compensate: (world) => {
            world.snapshot.exportJob.workerCount = previousCount;
            record(world, 'scale_pool', `scaled back to ${previousCount}`);
          },
        },
      ];
    }

    case 'drop_poison_message': {
      const quarantineId = `${argument}-quarantined`;

      return [
        {
          id: 'quarantine_copy',
          description: `copy ${argument} to the quarantine store before touching the queue`,
          reversible: true,
          act: (world) => {
            record(world, 'quarantine_copy', `copied ${argument} to ${quarantineId}`);
          },
          verify: (world) =>
            world.effects.some((effect) => effect.detail.includes(quarantineId))
              ? { ok: true, detail: `${quarantineId} readable from the quarantine store` }
              : { ok: false, detail: 'quarantine copy not found' },
          compensate: (world) => {
            record(world, 'quarantine_copy', `deleted ${quarantineId}`);
          },
        },
        {
          // Irreversible, last, and only reachable because a copy of the message
          // exists and has been read back. The copy does not make the drop
          // reversible — it makes the loss recoverable, which is a smaller claim.
          id: 'drop_head_message',
          description: `drop ${argument} from the export queue`,
          reversible: false,
          act: (world) => {
            world.snapshot.queueMessages = world.snapshot.queueMessages.filter(
              (message) => message.id !== argument,
            );
            record(world, 'drop_head_message', `dropped ${argument}`);
          },
          verify: (world) =>
            world.snapshot.queueMessages.every((message) => message.id !== argument)
              ? { ok: true, detail: `${argument} is gone from the queue` }
              : { ok: false, detail: `${argument} is still at the head of the queue` },
        },
      ];
    }

    case 'reissue_warehouse_grant': {
      const failedRun = 'run-2026-03-10-nightly';

      return [
        {
          id: 'reissue_grant',
          description: `reissue the ${argument} role to the export principal`,
          reversible: true,
          act: (world) => {
            const grant = grantFor(world, argument);
            if (grant === undefined) throw new Error(`no grant for role ${argument}`);
            grant.granted = true;
            record(world, 'reissue_grant', `${argument} granted to ${grant.principal}`);
          },
          verify: (world) =>
            grantFor(world, argument)?.granted === true
              ? { ok: true, detail: `${argument} reads as granted` }
              : { ok: false, detail: `${argument} is still not granted` },
          compensate: (world) => {
            const grant = grantFor(world, argument);
            if (grant !== undefined) grant.granted = false;
            record(world, 'reissue_grant', `${argument} revoked again`);
          },
        },
        {
          id: 'rebuild_manifest',
          description: 'rebuild the export manifest the failed window left behind',
          reversible: true,
          act: (world) => {
            world.snapshot.manifestRebuiltAt = '2026-03-11T02:58:00.000Z';
            record(world, 'rebuild_manifest', 'manifest rebuilt');
          },
          verify: (world) =>
            world.snapshot.manifestRebuiltAt !== null
              ? { ok: true, detail: `manifest timestamped ${world.snapshot.manifestRebuiltAt}` }
              : { ok: false, detail: 'manifest was not rebuilt' },
          compensate: (world) => {
            world.snapshot.manifestRebuiltAt = null;
            record(world, 'rebuild_manifest', 'manifest rebuild discarded');
          },
        },
        replayStep('replay_window', failedRun),
      ];
    }

    default:
      throw new Error(`No plan defined for tool "${tool.id}"`);
  }
}

/** A one-line description of an unbuilt plan, for the narration. */
export function planShape(steps: readonly Step<World>[]): string {
  return steps
    .map((step) => (step.reversible ? step.id : `${step.id} (irreversible)`))
    .join(' -> ');
}

/** True when the credential returned by `activeCredential` is the one a plan rotates. */
export function activeCredentialId(world: Readonly<World>): string | undefined {
  return activeCredential(world)?.id;
}
