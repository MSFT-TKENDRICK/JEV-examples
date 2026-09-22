/**
 * Checks for src/frontier.ts.
 *
 * The rankings below are hand-computed on a graph small enough to do in your
 * head, and pinned. That matters more here than in most check files: the
 * frontier is what the browser examples point at when they claim a point
 * estimate cannot backtrack, and a self-confirming test would make that claim
 * worth nothing.
 *
 * The graph, once, so the numbers below are readable:
 *
 *     root ──0.5──> A ──0.5──> A1     path p = 0.25
 *      │            └──0.5──> A2      path p = 0.25
 *      ├──0.3──> B                    path p = 0.30
 *      └──0.2──> C                    path p = 0.20
 *
 * Run:  node src/frontier.check.ts
 */

import { createFrontier, pathProbability } from './frontier.ts';
import type { FrontierChild } from './frontier.ts';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    failures++;
    console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function near(actual: number, expected: number, tolerance = 1e-9): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

const branch: readonly FrontierChild[] = [
  { elementId: 'ea', label: 'A', page: 'A', probability: 0.5 },
  { elementId: 'eb', label: 'B', page: 'B', probability: 0.3 },
  { elementId: 'ec', label: 'C', page: 'C', probability: 0.2 },
];

// --- the root ----------------------------------------------------------------

const f = createFrontier({ beamWidth: 3, rootPage: 'root' });

check('root starts open at depth 0', f.root().state === 'open' && f.root().depth === 0);
check('root has path probability 1', near(pathProbability(f.root()), 1));
check('root has no incoming element', f.root().elementId === null);
check('an unknown node id is rejected', (() => {
  try {
    f.node('nope');
    return false;
  } catch {
    return true;
  }
})());

// --- one branch, beam wide enough to hold it ---------------------------------

const level1 = f.expand(f.root().id, branch);

check('expand returns one node per positive-mass child', level1.length === 3);
check('root is marked expanded, not open', f.root().state === 'expanded');
check(
  'child path probabilities are the step probabilities',
  near(pathProbability(level1[0]!), 0.5) &&
    near(pathProbability(level1[1]!), 0.3) &&
    near(pathProbability(level1[2]!), 0.2),
);
check('best() is the heaviest branch, A', f.best()?.label === 'A');
check(
  'ranked() is A, B, C',
  f
    .ranked()
    .map((node) => node.label)
    .join(',') === 'A,B,C',
);
check('a beam of 3 over 3 children prunes nothing', f.stats().pruned === 0);

// --- a second level, and the beam starts biting ------------------------------

const level2 = f.expand(level1[0]!.id, [
  { elementId: 'ea1', label: 'A1', page: 'A1', probability: 0.5 },
  { elementId: 'ea2', label: 'A2', page: 'A2', probability: 0.5 },
]);

check('A1 accumulates to 0.5 * 0.5 = 0.25', near(pathProbability(level2[0]!), 0.25));
check(
  'the beam keeps the top 3 and prunes C, the weakest open path',
  f.stats().pruned === 1 && f.node(level1[2]!.id).state === 'pruned',
);
check('pruned mass is C at 0.2', near(f.stats().prunedMass, 0.2));
check(
  'best() is B at 0.30, ahead of A1 at 0.25 — depth is not a tiebreak here',
  f.best()?.label === 'B',
);
check(
  'exact ties break by creation order, so A1 outranks A2',
  f
    .ranked()
    .map((node) => node.label)
    .join(',') === 'B,A1,A2',
);

// --- backtracking, which is the entire point ---------------------------------

f.markDead(level1[1]!.id, 'proved terminal');
check('killing B resumes from A1, the best surviving alternative', f.best()?.label === 'A1');

check(
  'pathTo() replays the actions that reach A1',
  f
    .pathTo(level2[0]!.id)
    .map((step) => step.elementId)
    .join(',') === 'ea,ea1',
);

f.markDead(level2[0]!.id, 'proved terminal');
check('killing A1 resumes from A2', f.best()?.label === 'A2');

f.markDead(level2[1]!.id, 'proved terminal');
check('with every survivor dead, best() is null rather than a guess', f.best() === null);

const ended = f.stats();
check(
  'final bookkeeping accounts for every node',
  ended.open === 0 && ended.expanded === 2 && ended.dead === 3 && ended.pruned === 1,
  JSON.stringify(ended),
);

// --- the k=1 collapse, which is what an argmax interface leaves you with ------

const greedy = createFrontier({ beamWidth: 1, rootPage: 'root' });
const greedyLevel1 = greedy.expand(greedy.root().id, branch);

check('a beam of 1 keeps exactly one path open', greedy.stats().open === 1);
check(
  'a beam of 1 discards 0.5 of the mass at a single three-way branch',
  near(greedy.stats().prunedMass, 0.5),
);

greedy.markDead(greedyLevel1[0]!.id, 'proved terminal');
check(
  'at k=1 a dead end ends the search — there was never a second-best to keep',
  greedy.best() === null,
);

// --- renormalization and rejected input --------------------------------------

const scaled = createFrontier({ beamWidth: 4, rootPage: 'root' });
const scaledChildren = scaled.expand(scaled.root().id, [
  { elementId: 'x', label: 'X', page: 'X', probability: 2 },
  { elementId: 'y', label: 'Y', page: 'Y', probability: 1 },
  { elementId: 'z', label: 'Z', page: 'Z', probability: 1 },
]);
check(
  'unnormalized child masses are renormalized across the supplied set',
  near(pathProbability(scaledChildren[0]!), 0.5) && near(pathProbability(scaledChildren[1]!), 0.25),
);

const dropped = createFrontier({ beamWidth: 4, rootPage: 'root' });
const droppedChildren = dropped.expand(dropped.root().id, [
  { elementId: 'x', label: 'X', page: 'X', probability: 1 },
  { elementId: 'y', label: 'Y', page: 'Y', probability: 0 },
  { elementId: 'z', label: 'Z', page: 'Z', probability: -1 },
]);
check(
  'zero and negative masses are dropped rather than producing -Infinity paths',
  droppedChildren.length === 1 && near(pathProbability(droppedChildren[0]!), 1),
);

check(
  'a node cannot be expanded twice',
  (() => {
    try {
      dropped.expand(dropped.root().id, branch);
      return false;
    } catch {
      return true;
    }
  })(),
);

check(
  'a dead node cannot be expanded',
  (() => {
    const g = createFrontier({ beamWidth: 2, rootPage: 'root' });
    const kids = g.expand(g.root().id, branch);
    g.markDead(kids[0]!.id, 'proved terminal');
    try {
      g.expand(kids[0]!.id, branch);
      return false;
    } catch {
      return true;
    }
  })(),
);

check(
  'a beam width below 1 is rejected',
  (() => {
    try {
      createFrontier({ beamWidth: 0, rootPage: 'root' });
      return false;
    } catch {
      return true;
    }
  })(),
);

// -----------------------------------------------------------------------------

console.log(failures === 0 ? '\nfrontier: all checks passed' : `\nfrontier: ${failures} FAILED`);
if (failures > 0) process.exitCode = 1;
