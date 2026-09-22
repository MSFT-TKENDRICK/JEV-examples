/**
 * The probe set.
 *
 * A probe here is a read-only check the harness can run before committing to a
 * tool: ask the scheduler what it thinks it is doing, look at when the
 * credential expires, dry-run a write. Each one is cheap relative to every tool
 * in the catalog, which is not a nicety — a "probe" that costs as much as the
 * action it informs is just a worse version of the action, and the
 * information-gain argument would be dishonest.
 *
 * Each probe is written as a **partition**: for every observation, the list of
 * tools that would produce it. `partitionProbe()` turns that into the
 * likelihood matrix that `assess()` needs. The partition is the authored part
 * of this file and the part a reader should be most sceptical of. It encodes a
 * claim about the world — "if the credential has expired, the first action is
 * a rotation" — and that claim is the fixture author's, not the model's and not
 * this repository's. The arithmetic over it is real; the inputs to the
 * arithmetic are manufactured.
 *
 * `none_of_these` deliberately appears in no bucket. `partitionProbe()` treats
 * a candidate it has never seen as uninformative rather than impossible, so a
 * probe cannot drive the abstention option's mass to zero just by not
 * mentioning it. That is the behaviour you want: no diagnostic tells you
 * "the answer is none of these".
 */

import type { Probe } from '../information-gain.ts';
import { partitionProbe } from '../information-gain.ts';
import type { ProbeFacts, World } from './world.ts';
import { readFact } from './world.ts';

export interface HarnessProbe {
  probe: Probe;
  /** Which observable fact this probe reads. */
  fact: keyof ProbeFacts;
}

const DEFINITIONS: readonly HarnessProbe[] = [
  {
    fact: 'scheduler_status',
    probe: partitionProbe(
      'scheduler_status',
      1,
      {
        schedule_paused: ['replay_export_window'],
        runs_failing: [
          'rotate_export_credential',
          'drop_poison_message',
          'reissue_warehouse_grant',
        ],
        runs_succeeding_no_rows: ['resize_worker_pool', 'replay_export_window'],
      },
      'read the export schedule and the status of its last runs',
    ),
  },
  {
    fact: 'credential_expiry',
    probe: partitionProbe(
      'credential_expiry',
      1,
      {
        expired: ['rotate_export_credential'],
        valid: [
          'replay_export_window',
          'resize_worker_pool',
          'drop_poison_message',
          'reissue_warehouse_grant',
        ],
      },
      'read the expiry timestamp on the credential the job authenticates with',
    ),
  },
  {
    fact: 'worker_pool_health',
    probe: partitionProbe(
      'worker_pool_health',
      2,
      {
        starved: ['resize_worker_pool'],
        healthy: [
          'rotate_export_credential',
          'replay_export_window',
          'drop_poison_message',
          'reissue_warehouse_grant',
        ],
      },
      'read worker saturation and queue wait times over the incident window',
    ),
  },
  {
    fact: 'queue_depth',
    probe: partitionProbe(
      'queue_depth',
      2,
      {
        wedged_head: ['drop_poison_message'],
        draining: ['resize_worker_pool'],
        empty: [
          'rotate_export_credential',
          'replay_export_window',
          'reissue_warehouse_grant',
        ],
      },
      'read queue depth and the delivery count on the head message',
    ),
  },
  {
    fact: 'warehouse_grant_dryrun',
    probe: partitionProbe(
      'warehouse_grant_dryrun',
      3,
      {
        permission_denied: ['reissue_warehouse_grant', 'rotate_export_credential'],
        write_ok: ['replay_export_window', 'resize_worker_pool', 'drop_poison_message'],
      },
      'dry-run a zero-row write to the warehouse and read the error, if any',
    ),
  },
];

export const PROBES: readonly Probe[] = DEFINITIONS.map((definition) => definition.probe);

/**
 * Runs a probe.
 *
 * The signature is the guarantee: `Readonly<World>` in, a string out. There is
 * no path through this function that can change the world, so "probing is free
 * of consequences" is enforced by the type checker rather than asserted in a
 * comment.
 */
export function runProbe(world: Readonly<World>, probeId: string): string {
  const definition = DEFINITIONS.find((entry) => entry.probe.id === probeId);
  if (definition === undefined) throw new Error(`No probe named "${probeId}"`);
  return readFact(world, definition.fact);
}

export function probeById(probeId: string): Probe | undefined {
  return PROBES.find((probe) => probe.id === probeId);
}

/** Total cost of a set of probes, for budgeting. */
export function totalCost(probeIds: readonly string[]): number {
  return probeIds.reduce((sum, id) => sum + (probeById(id)?.cost ?? 0), 0);
}

/** The cheapest probe not yet run — the naive policy the EIG policy is compared against. */
export function cheapestRemaining(run: readonly string[]): Probe | undefined {
  return [...PROBES]
    .filter((probe) => !run.includes(probe.id))
    .sort((a, b) => a.cost - b.cost)[0];
}
