/**
 * Argument binding.
 *
 * Choosing a tool and choosing what to point it at are two different decisions,
 * and this file exists because they must not be made in the same breath.
 *
 * The reason is not stylistic. A single request that asks "which tool, and
 * which record?" returns two independently selected marginals, and independent
 * marginals do not compose into a coherent joint call: the most likely tool and
 * the most likely record can easily be a pair that makes no sense together,
 * because the candidate records are *conditional on the tool*. So binding
 * happens in a second, step-specific stage, over a candidate set that only
 * exists once the tool is known.
 *
 * The second rule is that an argument is never taken as text. Every identifier
 * must resolve in the system of record, and the check runs in application code
 * on whatever was proposed — by Jev, by a generative model, or by a customer
 * writing a plausible-looking run id into a support ticket. An identifier that
 * does not resolve is rejected because it does not resolve, not because of
 * where it came from.
 */

import type { ArgumentKind, ToolSpec } from './catalog.ts';
import type { World } from './world.ts';

export interface ArgumentCandidate {
  id: string;
  /** Why this record is a candidate, shown as the Choice criteria text. */
  criteria: string;
}

/** The option offered when no candidate record fits. */
export const NO_CANDIDATE = 'no_suitable_record';

/**
 * Enumerates the authoritative records a tool could be pointed at.
 *
 * An empty result is meaningful and is not an error: it says the system of
 * record holds nothing this tool could act on, which is a refusal the harness
 * can reach without consulting anything.
 */
export function candidateArguments(
  world: Readonly<World>,
  kind: ArgumentKind,
): ArgumentCandidate[] {
  switch (kind) {
    case 'credential':
      return world.snapshot.credentials
        .filter((credential) => credential.active)
        .map((credential) => ({
          id: credential.id,
          criteria: `${credential.label}, expires ${credential.expiresAt}`,
        }));

    case 'export_run':
      return world.snapshot.exportRuns
        .filter((run) => run.status !== 'succeeded')
        .map((run) => ({
          id: run.id,
          criteria: `export window ${run.window}, status ${run.status}, ${run.rows} rows landed`,
        }));

    case 'queue_message':
      return world.snapshot.queueMessages.map((message) => ({
        id: message.id,
        criteria: `enqueued ${message.enqueuedAt}, ${message.attempts} delivery attempts`,
      }));

    case 'grant_role':
      return world.snapshot.grants.map((grant) => ({
        id: grant.role,
        criteria: `${grant.role} for ${grant.principal}, currently ${grant.granted ? 'granted' : 'not granted'}`,
      }));

    case 'worker_pool':
      return [
        {
          id: world.snapshot.exportJob.id,
          criteria: `export job running on ${world.snapshot.exportJob.workerCount} worker(s)`,
        },
      ];
  }
}

export type Binding =
  | { ok: true; kind: ArgumentKind; value: string; source: string }
  | { ok: false; proposed: string; reason: string };

/**
 * Resolves a proposed identifier against the system of record.
 *
 * This runs even on identifiers Jev selected from an enumerated candidate set,
 * which looks redundant and is not. The enumeration and the execution read the
 * snapshot at different moments, and a check that only guards the untrusted
 * path is a check that stops running the moment someone adds a trusted one.
 */
export function bindArgument(
  world: Readonly<World>,
  tool: ToolSpec,
  proposed: string,
): Binding {
  const source = world.snapshot.source;
  const candidates = candidateArguments(world, tool.argument);

  if (candidates.length === 0) {
    return {
      ok: false,
      proposed,
      reason: `${source} holds no ${tool.argument.replace('_', ' ')} this tool could act on`,
    };
  }

  const match = candidates.find((candidate) => candidate.id === proposed);
  if (match === undefined) {
    return {
      ok: false,
      proposed,
      reason:
        `no ${tool.argument.replace('_', ' ')} with this identifier in ${source} ` +
        `(candidates: ${candidates.map((candidate) => candidate.id).join(', ')})`,
    };
  }

  return { ok: true, kind: tool.argument, value: match.id, source };
}
