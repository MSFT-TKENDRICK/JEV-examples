/**
 * The tool catalog.
 *
 * The thing that makes this example worth writing is that these tools are
 * **co-applicable**. They are not five labels for one failure; on the evidence
 * available at the start, several of them could each be the right first move,
 * and running the wrong one is not free. Two of them destroy something.
 *
 * That is precisely the shape where an argmax is least informative. "Replay the
 * window" as a bare answer is indistinguishable from "replay the window, but it
 * was nearly a coin flip against rotating the credential" — and those two
 * situations call for completely different next moves. The first says commit.
 * The second says go and look at the credential first, because the observation
 * is cheap and the mistake is not.
 *
 * Each entry also declares what it would *cost* and whether it can be undone.
 * Neither figure is consumed by the Choice — Jev is asked which action to run
 * first, not which is cheapest — but both are used by application code, which
 * is where that judgement belongs.
 */

/** The kind of authoritative identifier a tool needs bound before it can run. */
export type ArgumentKind =
  | 'credential'
  | 'export_run'
  | 'queue_message'
  | 'grant_role'
  | 'worker_pool';

export interface ToolSpec {
  id: string;
  /** The criteria text Jev sees for this option. Describes the *evidence*, not the fix. */
  criteria: string;
  /** One line for the human reading the terminal. */
  summary: string;
  /** Which authoritative identifier must be bound before the plan can be built. */
  argument: ArgumentKind;
  /** Rough units of disruption. Authored; used by code, never shown to the model. */
  cost: number;
  /**
   * Whether the plan for this tool contains a point of no return. `runPlan`
   * enforces that such a step is last and runs only after everything else has
   * been verified; this flag is just how the narration knows to say so.
   */
  hasIrreversibleStep: boolean;
}

/**
 * The option Jev can pick when the evidence fits none of the above.
 *
 * Present for the usual reason — without it, a Choice forces mass onto the
 * least bad option and the distribution stops meaning what it appears to mean.
 */
export const NONE_OPTION = 'none_of_these';

export const TOOLS: readonly ToolSpec[] = [
  {
    id: 'rotate_export_credential',
    criteria:
      'The evidence points at the export job authenticating with a credential that the ' +
      'warehouse no longer accepts — expiry, revocation, or a rejected secret.',
    summary: 'stage a new warehouse credential, repoint the job, revoke the old secret',
    argument: 'credential',
    cost: 8,
    hasIrreversibleStep: true,
  },
  {
    id: 'replay_export_window',
    criteria:
      'The evidence points at a single window that was skipped or produced no rows, with ' +
      'the pipeline otherwise working now.',
    summary: 'claim the missed window and re-run it, then check rows actually landed',
    argument: 'export_run',
    cost: 5,
    hasIrreversibleStep: false,
  },
  {
    id: 'resize_worker_pool',
    criteria:
      'The evidence points at the export workers being starved of capacity — queued work ' +
      'draining slower than it arrives, runs timing out rather than erroring.',
    summary: 'scale the export worker pool back up and confirm throughput recovers',
    argument: 'worker_pool',
    cost: 2,
    hasIrreversibleStep: false,
  },
  {
    id: 'drop_poison_message',
    criteria:
      'The evidence points at one message at the head of the export queue that fails ' +
      'repeatedly and blocks everything behind it.',
    summary: 'quarantine a copy of the head message, then drop it from the queue',
    argument: 'queue_message',
    cost: 6,
    hasIrreversibleStep: true,
  },
  {
    id: 'reissue_warehouse_grant',
    criteria:
      'The evidence points at the export principal having lost the warehouse role it ' +
      'writes with — authentication succeeding but the write being refused.',
    summary: 'reissue the warehouse role, rebuild the manifest, replay the window',
    argument: 'grant_role',
    cost: 4,
    hasIrreversibleStep: false,
  },
];

export const TOOL_IDS: readonly string[] = TOOLS.map((tool) => tool.id);

export function toolById(id: string): ToolSpec | undefined {
  return TOOLS.find((tool) => tool.id === id);
}

/** The Choice criteria map, plus the none option. */
export function toolCriteria(): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const tool of TOOLS) criteria[tool.id] = tool.criteria;
  criteria[NONE_OPTION] =
    'The evidence fits none of the above, or fits several of them equally with nothing ' +
    'distinguishing them.';
  return criteria;
}
