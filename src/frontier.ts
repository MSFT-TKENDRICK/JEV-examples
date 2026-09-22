/**
 * Probability-weighted beam search with backtracking.
 *
 * This is the file that makes the browser examples an argument rather than a
 * demo, so it is worth stating the argument before the code.
 *
 * A greedy agent at a branch point takes its best guess and walks. If that
 * branch turns out to be a dead end three pages later, it has nothing to go
 * back to. Not because backtracking is hard to implement, but because the
 * information needed to backtrack *usefully* — which of the roads not taken was
 * next best, and by how much — was discarded the moment the model returned one
 * answer instead of a distribution.
 *
 *     The alternatives you back up to are exactly the probability mass you
 *     threw away at the branch point.
 *
 * So this is the capability a point estimate cannot supply. A distribution over
 * six affordances ranks all six; a single answer ranks one. Set `beamWidth` to
 * 1, which is what an argmax interface gives you whether you ask for it or not,
 * and `best()` returns `null` the first time the only live path dies. There is
 * no second-best, because a second-best was never expressible.
 *
 * What this file does NOT claim:
 *
 * - Not that beam search is optimal. It is a bounded, greedy frontier; a wider
 *   beam or a proper A* with an admissible heuristic can beat it, and on a maze
 *   built adversarially against the beam it would lose.
 * - Not that the probabilities weighting the beam are calibrated. Garbage
 *   probabilities produce a confidently misordered frontier. The claim is about
 *   what the search can be built to do *given* a distribution, not about the
 *   quality of any particular one.
 * - Not that a generative model cannot drive a beam. It can, if you make it
 *   emit scores for every candidate and you are willing to trust them. The
 *   narrow claim is about what a bare argmax supplies.
 *
 * Accumulated path probability is held in logs. A ten-step path at p=0.3 a step
 * is 6e-6, and the comparisons that matter here are between paths of unequal
 * length, so the underflow is not hypothetical.
 */

export type NodeState = 'open' | 'expanded' | 'dead' | 'pruned';

/** A successor offered to `expand()`, weighted by the step's distribution. */
export interface FrontierChild {
  /** The affordance actioned to get here. */
  elementId: string;
  /** Human label, carried so narration and `pathTo()` read as actions. */
  label: string;
  /** Where it leads. Opaque to this file. */
  page: string;
  /** Mass the step's distribution put on this element. Must be > 0. */
  probability: number;
}

export interface FrontierNode {
  id: string;
  parentId: string | null;
  page: string;
  /** The affordance actioned on the parent to reach this node. */
  elementId: string | null;
  label: string;
  /** ln of the accumulated path probability. The root is 0, i.e. p = 1. */
  logProbability: number;
  depth: number;
  state: NodeState;
  /** Why this node was abandoned. Set for `dead` and `pruned`. */
  reason?: string;
  /** Monotonic creation order, used only to break exact ties deterministically. */
  sequence: number;
}

export interface FrontierStats {
  open: number;
  expanded: number;
  dead: number;
  pruned: number;
  /**
   * Total path probability of everything the beam discarded.
   *
   * Worth printing. At k=1 on a six-way branch this is most of the
   * distribution, and it is the concrete form of "what argmax throws away".
   */
  prunedMass: number;
  beamWidth: number;
}

export interface FrontierOptions {
  /**
   * How many partial paths to keep alive. 1 reproduces a greedy walk, which is
   * what an argmax interface leaves you with.
   */
  beamWidth: number;
  /** Page the search starts on. */
  rootPage: string;
  /** Label for the root, used in narration. */
  rootLabel?: string;
}

export interface Frontier {
  root(): FrontierNode;
  node(id: string): FrontierNode;
  /**
   * Records the successors of `nodeId` and re-applies the beam.
   *
   * Child probabilities are renormalized across the supplied set, so a caller
   * can hand over the live subset of a Jev distribution — the elements that
   * actually navigate, with `none` and already-visited pages filtered out —
   * and still get a meaningful conditional path probability. Non-positive
   * masses are dropped rather than producing a -Infinity path.
   */
  expand(nodeId: string, children: readonly FrontierChild[]): readonly FrontierNode[];
  /** The open node with the highest accumulated path probability, or null. */
  best(): FrontierNode | null;
  /** All open nodes, best first. */
  ranked(): readonly FrontierNode[];
  /** Abandons a node. The next `best()` resumes from the surviving alternative. */
  markDead(nodeId: string, reason: string): void;
  /** Root-to-node actions, as `{ elementId, label, page }`, excluding the root. */
  pathTo(nodeId: string): readonly { elementId: string; label: string; page: string }[];
  /** Every node ever created, in creation order. For the ledger and the narration. */
  all(): readonly FrontierNode[];
  stats(): FrontierStats;
}

/** Accumulated path probability of a node, back out of log space. */
export function pathProbability(node: FrontierNode): number {
  return Math.exp(node.logProbability);
}

/**
 * Ordering over open nodes: likelier first, then shallower, then older.
 *
 * The epsilon is not decoration. Two paths can be equal in exact arithmetic and
 * differ in the last bit after going through logs, and a comparator that let
 * that decide would make the frontier's behaviour depend on floating-point
 * noise. Below the epsilon the tie is broken by depth — prefer the path that
 * has committed to less — and then by creation order, which is total.
 */
const TIE_EPSILON = 1e-12;

function compare(a: FrontierNode, b: FrontierNode): number {
  const gap = b.logProbability - a.logProbability;
  if (Math.abs(gap) > TIE_EPSILON) return gap;
  if (a.depth !== b.depth) return a.depth - b.depth;
  return a.sequence - b.sequence;
}

export function createFrontier(options: FrontierOptions): Frontier {
  const { beamWidth, rootPage, rootLabel = 'start' } = options;
  if (!Number.isInteger(beamWidth) || beamWidth < 1) {
    throw new Error(`beamWidth must be a positive integer, got ${String(beamWidth)}`);
  }

  const nodes = new Map<string, FrontierNode>();
  const order: string[] = [];
  let sequence = 0;

  const create = (
    parent: FrontierNode | null,
    page: string,
    elementId: string | null,
    label: string,
    logProbability: number,
  ): FrontierNode => {
    const node: FrontierNode = {
      id: `n${sequence}`,
      parentId: parent?.id ?? null,
      page,
      elementId,
      label,
      logProbability,
      depth: parent === null ? 0 : parent.depth + 1,
      state: 'open',
      sequence,
    };
    sequence++;
    nodes.set(node.id, node);
    order.push(node.id);
    return node;
  };

  const rootNode = create(null, rootPage, null, rootLabel, 0);

  const get = (id: string): FrontierNode => {
    const found = nodes.get(id);
    if (found === undefined) throw new Error(`No such frontier node: ${id}`);
    return found;
  };

  const openNodes = (): FrontierNode[] =>
    order
      .map((id) => get(id))
      .filter((node) => node.state === 'open')
      .sort(compare);

  /**
   * Keeps the top `beamWidth` open nodes and prunes the rest.
   *
   * Pruning is permanent. A frontier that quietly revived pruned nodes when it
   * ran out would make `beamWidth` meaningless and would hide the k=1 collapse
   * this file exists to show.
   */
  const applyBeam = (): void => {
    const open = openNodes();
    for (const node of open.slice(beamWidth)) {
      node.state = 'pruned';
      node.reason = `outside the beam (width ${beamWidth})`;
    }
  };

  return {
    root: () => rootNode,
    node: get,

    expand(nodeId, children) {
      const parent = get(nodeId);
      if (parent.state === 'expanded') {
        throw new Error(`Frontier node ${nodeId} has already been expanded`);
      }
      if (parent.state !== 'open') {
        throw new Error(`Cannot expand ${parent.state} frontier node ${nodeId}`);
      }

      const live = children.filter((child) => child.probability > 0);
      const total = live.reduce((sum, child) => sum + child.probability, 0);

      parent.state = 'expanded';
      if (total <= 0) return [];

      const created = live.map((child) =>
        create(
          parent,
          child.page,
          child.elementId,
          child.label,
          parent.logProbability + Math.log(child.probability / total),
        ),
      );

      applyBeam();
      return created;
    },

    best() {
      return openNodes()[0] ?? null;
    },

    ranked() {
      return openNodes();
    },

    markDead(nodeId, reason) {
      const node = get(nodeId);
      node.state = 'dead';
      node.reason = reason;
    },

    pathTo(nodeId) {
      const steps: { elementId: string; label: string; page: string }[] = [];
      let cursor: FrontierNode | null = get(nodeId);
      while (cursor !== null && cursor.elementId !== null) {
        steps.push({ elementId: cursor.elementId, label: cursor.label, page: cursor.page });
        cursor = cursor.parentId === null ? null : get(cursor.parentId);
      }
      return steps.reverse();
    },

    all() {
      return order.map((id) => get(id));
    },

    stats() {
      const all = order.map((id) => get(id));
      const count = (state: NodeState) => all.filter((node) => node.state === state).length;
      return {
        open: count('open'),
        expanded: count('expanded'),
        dead: count('dead'),
        pruned: count('pruned'),
        prunedMass: all
          .filter((node) => node.state === 'pruned')
          .reduce((sum, node) => sum + pathProbability(node), 0),
        beamWidth,
      };
    },
  };
}
