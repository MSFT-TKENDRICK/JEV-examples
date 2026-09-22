/**
 * The world the harness acts on.
 *
 * Two things live here and they are deliberately separated.
 *
 * The **snapshot** is a system of record: credentials, export runs, queue
 * messages, grants. It is the only source of authoritative identifiers, which
 * is what `bind.ts` checks arguments against. Anything not in here does not
 * exist, no matter how confidently something proposed it.
 *
 * The **facts** are what a read-only probe would observe. They are fixed per
 * incident and a probe cannot change them — `readFact()` takes a `Readonly<World>`
 * and returns a string, which is the whole of its power. That constraint is
 * structural rather than documentary, because "the probes are read-only" is an
 * assumption the entire information-gain argument rests on: a probe with side
 * effects is just a cheap action that has not admitted it.
 *
 * What this file is not: a simulator. The facts are authored per scenario. It
 * manufactures a world consistent enough that steps can act, verify by reading
 * back, and compensate — nothing more.
 */

/** A warehouse credential the export job can authenticate with. */
export interface Credential {
  id: string;
  label: string;
  expiresAt: string;
  active: boolean;
}

/** One attempt at the nightly export. */
export interface ExportRun {
  id: string;
  window: string;
  status: 'failed' | 'succeeded' | 'queued';
  rows: number;
}

/** A message sitting in the export queue. */
export interface QueueMessage {
  id: string;
  enqueuedAt: string;
  attempts: number;
}

/** A warehouse role grant held by a service principal. */
export interface Grant {
  principal: string;
  role: string;
  granted: boolean;
}

/**
 * The authoritative record. Every identifier the harness is allowed to put in a
 * tool call comes from this object and nowhere else.
 */
export interface SystemOfRecord {
  source: string;
  readAt: string;
  tenantId: string;
  exportJob: { id: string; credentialId: string; workerCount: number };
  credentials: Credential[];
  exportRuns: ExportRun[];
  queueMessages: QueueMessage[];
  grants: Grant[];
  manifestRebuiltAt: string | null;
}

/** Everything a read-only probe can observe. Authored per incident. */
export interface ProbeFacts {
  scheduler_status: 'schedule_paused' | 'runs_failing' | 'runs_succeeding_no_rows';
  credential_expiry: 'expired' | 'valid';
  worker_pool_health: 'starved' | 'healthy';
  queue_depth: 'wedged_head' | 'draining' | 'empty';
  warehouse_grant_dryrun: 'permission_denied' | 'write_ok';
}

/**
 * Outcomes the fixture controls that are not observable by any probe.
 *
 * These exist so a step can fail *verification* rather than failing to act,
 * which is the interesting case: the action reported success and the world did
 * not end up the way the action claimed.
 */
export interface WorldOutcomes {
  /** Rows a replayed export window actually lands. Zero means nothing arrived. */
  replayRowCount: number;
  /** Whether a freshly staged credential authenticates against the warehouse. */
  newCredentialAuthenticates: boolean;
}

/** One thing the harness did, in the order it did it. */
export interface Effect {
  step: string;
  detail: string;
}

export interface World {
  incident: string;
  snapshot: SystemOfRecord;
  readonly facts: ProbeFacts;
  readonly outcomes: WorldOutcomes;
  /** Append-only log of what acted. Compensation appends too, rather than erasing. */
  effects: Effect[];
}

/** Reads one observable fact. Read-only by type, not merely by convention. */
export function readFact(world: Readonly<World>, fact: keyof ProbeFacts): string {
  return world.facts[fact];
}

export function record(world: World, step: string, detail: string): void {
  world.effects.push({ step, detail });
}

export function credentialById(world: Readonly<World>, id: string): Credential | undefined {
  return world.snapshot.credentials.find((credential) => credential.id === id);
}

export function activeCredential(world: Readonly<World>): Credential | undefined {
  return world.snapshot.credentials.find((credential) => credential.active);
}

export function grantFor(world: Readonly<World>, role: string): Grant | undefined {
  return world.snapshot.grants.find((grant) => grant.role === role);
}

export interface WorldSeed {
  incident: string;
  facts: ProbeFacts;
  outcomes: WorldOutcomes;
  /** Export runs the system of record actually holds. Default: one failed run. */
  exportRuns?: ExportRun[];
  /** Queue messages, head first. Default: one wedged message. */
  queueMessages?: QueueMessage[];
  /** Whether the warehouse writer role is currently granted. Default: true. */
  writerGranted?: boolean;
}

/**
 * Builds a fresh world per scenario.
 *
 * Fresh matters: one scenario rolls a plan back, and a shared mutable snapshot
 * would carry compensated effects into the next run and make the output a lie.
 */
export function createWorld(seed: WorldSeed): World {
  return {
    incident: seed.incident,
    snapshot: {
      source: 'export-control-plane@v3',
      readAt: '2026-03-11T02:40:00.000Z',
      tenantId: 'tenant-4417',
      exportJob: { id: 'job-nightly-warehouse', credentialId: 'cred-wh-2025-11', workerCount: 2 },
      credentials: [
        {
          id: 'cred-wh-2025-11',
          label: 'warehouse writer (current)',
          expiresAt: '2026-03-10T00:00:00.000Z',
          active: true,
        },
      ],
      exportRuns: seed.exportRuns ?? [
        { id: 'run-2026-03-10-nightly', window: '2026-03-10', status: 'failed', rows: 0 },
      ],
      queueMessages: seed.queueMessages ?? [
        { id: 'msg-8f21c4', enqueuedAt: '2026-03-10T02:05:00.000Z', attempts: 41 },
      ],
      grants: [
        {
          principal: 'svc-export@tenant-4417',
          role: 'warehouse_writer',
          granted: seed.writerGranted ?? true,
        },
      ],
      manifestRebuiltAt: null,
    },
    facts: seed.facts,
    outcomes: seed.outcomes,
    effects: [],
  };
}
