/**
 * 06 - The same maze, twice: a distribution against a point estimate.
 *
 * Same site, same loop, same click mechanics, same scripted judgements. The
 * only difference between the arms is the *shape* of what the decision model
 * returns:
 *
 *   Jev arm      a distribution over the page's elements
 *   control arm  the same answers with everything but the argmax thrown away
 *
 * The control arm is built by degrading the Jev arm - `toPointEstimate` takes
 * the distribution and returns `{ [argmax]: 1 }` - so nothing else can differ.
 *
 * READ THIS BEFORE QUOTING THE RESULT
 *
 * The control arm is an adversarial fixture, not a fair benchmark. A competent
 * generative implementation, constrained the same way, could pass the same
 * checks: it could be made to emit scores over the candidate list, and those
 * scores could drive the same beam and the same probe selection. The claim here
 * is narrow and it is about interface shape, not about model quality:
 *
 *   a bare point estimate does not supply the two things this application
 *   needs - a ranked alternative to resume from, and a non-degenerate prior
 *   for expected information gain.
 *
 * Both of those are demonstrated below as arithmetic, not as a score.
 *
 * Run:  node examples/06-jev-vs-control.ts
 */

import { assess, eigIsDegenerate, entropy } from '../src/information-gain.ts';
import { createClient } from '../src/client.ts';
import type { BrowseAction } from '../src/control-agent.ts';
import { createControlJudge } from '../src/control-agent.ts';
import type { SiteScript } from '../src/site/judges.ts';
import { createJevJudge } from '../src/site/judges.ts';
import type { WalkResult } from '../src/site/walk.ts';
import { toProbes, walk } from '../src/site/walk.ts';
import { SITE, TASK, page } from '../src/site/graph.ts';
import { banner, bold, cyan, dim, green, note, red, title } from '../src/ui.ts';

/**
 * One fixture, run twice. The home page puts most of its mass on the trap and
 * keeps a real minority on the route that works - which is precisely the
 * situation where the two arms come apart.
 */
const SCRIPT: SiteScript = {
  home: {
    target: {
      distribution: { e1: 0.62, e2: 0.06, e3: 0.05, e4: 0.04, e5: 0.13, e6: 0.09, none: 0.01 },
    },
    goalMet: { noul: 0.01 },
    atTarget: { noul: 0.04 },
    deadEnd: { noul: 0.02 },
  },
  documents: {
    target: { distribution: { e1: 0.28, e2: 0.64, e3: 0.03, none: 0.05 } },
    goalMet: { noul: 0.02 },
    atTarget: { noul: 0.11 },
    deadEnd: { noul: 0.06 },
  },
  archive: {
    target: { distribution: { e1: 0.88, e2: 0.05, none: 0.07 } },
    goalMet: { noul: 0.02 },
    atTarget: { noul: 0.09 },
    deadEnd: { noul: 0.12 },
  },
  archive2025: {
    target: { distribution: { e1: 0.11, none: 0.89 } },
    goalMet: { noul: 0.01 },
    atTarget: { noul: 0.02 },
    deadEnd: { noul: 0.94 },
  },
  billing: {
    target: { distribution: { e1: 0.3, e2: 0.36, e3: 0.32, e4: 0.01, none: 0.01 } },
    goalMet: { noul: 0.02 },
    atTarget: { noul: 0.31 },
    deadEnd: { noul: 0.02 },
  },
  chargeSep: {
    target: { distribution: { e1: 0.93, e2: 0.02, e3: 0.02, none: 0.03 } },
    goalMet: { noul: 0.06 },
    atTarget: { noul: 0.44 },
    deadEnd: { noul: 0.02 },
  },
  reissue: {
    target: { distribution: { e1: 0.02, e2: 0.02, e3: 0.94, none: 0.02 } },
    goalMet: { noul: 0.05 },
    atTarget: { noul: 0.93 },
    deadEnd: { noul: 0.01 },
  },
  submitted: {
    target: { distribution: { e1: 0.06, none: 0.94 } },
    goalMet: { noul: 0.97 },
    atTarget: { noul: 0.21 },
    deadEnd: { noul: 0.02 },
  },
};

/**
 * The control arm's replies.
 *
 * Deliberately good ones: it picks the same first link the distribution's
 * argmax picks, and it correctly recognises the archive as a dead end and asks
 * to back up. It fails anyway, and where it fails is the point.
 */
const CONTROL_REPLIES: Record<string, BrowseAction> = {
  home: { done: false, atTarget: false, deadEnd: false, elementId: 'e1', confidence: 0.62 },
  documents: { done: false, atTarget: false, deadEnd: false, elementId: 'e2', confidence: 0.64 },
  archive: { done: false, atTarget: false, deadEnd: false, elementId: 'e1', confidence: 0.88 },
  archive2025: { done: false, atTarget: false, deadEnd: true, elementId: 'none', confidence: 0.91 },
  billing: { done: false, atTarget: false, deadEnd: false, elementId: 'e2', confidence: 0.41 },
  chargeSep: { done: false, atTarget: false, deadEnd: false, elementId: 'e1', confidence: 0.93 },
  reissue: { done: false, atTarget: true, deadEnd: false, elementId: 'e3', confidence: 0.94 },
  submitted: { done: true, atTarget: false, deadEnd: false, elementId: 'none', confidence: 0.96 },
};

function trace(result: WalkResult): string {
  return result.history.length === 0 ? '(nothing)' : result.history.join(' -> ');
}

function report(label: string, detail: string, result: WalkResult): void {
  const ok = result.status === 'goal_reached';
  console.log(`\n  ${bold(label)}  ${dim(detail)}`);
  console.log(`    ${dim('path   ')} ${trace(result)}`);
  console.log(
    `    ${dim('cost   ')} ${result.steps} pages · ${result.judgeCalls} requests · ` +
      `${result.probes.length} probes costing ${result.budgetSpent} · ` +
      `${result.backtracks.length} backtrack(s)`,
  );
  console.log(
    `    ${dim('frontier')} beam ${result.frontier.beamWidth} · ` +
      `${result.frontier.open} open · ${result.frontier.dead} dead · ` +
      `${result.frontier.pruned} pruned holding ${result.frontier.prunedMass.toFixed(4)} of path mass`,
  );
  console.log(`    ${dim('outcome')} ${ok ? green(result.status) : red(result.status)}`);
  console.log(note(result.reason, 13));
}

title('06 - The same maze, twice');
banner(createClient().live);
console.log(`\n  ${dim(TASK)}`);

const jev = createJevJudge({ script: SCRIPT, beamWidth: 3 });
const control = createControlJudge({
  scripted: CONTROL_REPLIES,
  // The replay sleep stands in for generation time. Offline it is trimmed so
  // the example stays runnable; no timing claim is made from these runs.
  thinkMs: Number(process.env['CONTROL_THINK_MS'] ?? 120),
});

const jevRun = await walk({ judge: jev });
const controlRun = await walk({ judge: control });

report('jev     ', jev.detail, jevRun);
report('control ', control.detail, controlRun);

// ---------------------------------------------------------------------------
// Failure attribution. Not "it scored worse" - the specific capability that
// was missing, and where it was needed.
// ---------------------------------------------------------------------------

console.log(`\n${bold('what the control arm lacked')}`);

const home = page('home');
const homePrior = { e1: 0.6263, e2: 0.0606, e3: 0.0505, e4: 0.0404, e5: 0.1313, e6: 0.0909 };
const pointPrior = { e1: 1 };

console.log(
  note(
    [
      `1. Something to back up to. Both arms clicked "${home.elements[0]?.label}" first. Three pages`,
      '   later the archive proves the branch finished, and - importantly - the control arm knew it:',
      '   its schema has a `deadEnd` field and it set it. It asked to back up. There was nowhere to',
      `   back up to, so ${controlRun.status} was the only answer available.`,
      '',
      '   The alternatives you back up to are exactly the probability mass you threw away at the',
      `   branch point. Here that is ${jevRun.backtracks[0]?.alternativeMass.toFixed(4) ?? 'n/a'} of path probability, sitting on "Billing history",`,
      '   which is the link that works.',
    ],
    2,
  ),
);

const probes = toProbes(page('billing')).concat(toProbes(home));
const distributionEntropy = entropy(Object.values(homePrior));
const pointEntropy = entropy(Object.values(pointPrior));

console.log(
  note(
    [
      '',
      '2. A prior worth probing. Expected information gain is the entropy a probe is expected to',
      '   remove. Over a point mass there is none to remove:',
      '',
      `     H(distribution) = ${distributionEntropy.toFixed(4)} bits      H(point estimate) = ${pointEntropy.toFixed(4)} bits`,
      `     eigIsDegenerate(distribution) = ${String(eigIsDegenerate(homePrior))}   eigIsDegenerate(point estimate) = ${String(eigIsDegenerate(pointPrior))}`,
      '',
      '   So every probe on the site scores exactly zero against the point estimate. Not "harder',
      '   to choose between" - worthless, all of them, identically:',
    ],
    2,
  ),
);

for (const probe of probes) {
  const withDistribution = assess(homePrior, probe).expectedInformationGain;
  const withPoint = assess(pointPrior, probe).expectedInformationGain;
  console.log(
    `     ${cyan(probe.id.padEnd(16))} ${dim('distribution')} ${withDistribution.toFixed(4)}   ` +
      `${dim('point estimate')} ${withPoint.toFixed(4)}`,
  );
}

console.log(
  note(
    [
      '',
      '   A probe-selection loop over a point estimate has nothing to rank. `selectProbe` returns',
      '   no choice, and the agent proceeds on the answer it already had - which is the behaviour',
      '   the point estimate was always going to produce, with extra machinery attached.',
    ],
    2,
  ),
);

// ---------------------------------------------------------------------------

console.log(`\n${bold('the honest reading')}`);
console.log(
  note(
    [
      'This is a scripted fixture over a site written for the purpose. The labels are confusable',
      'because they were written to be, the trap is three pages deep because it was built three',
      'pages deep, and the probe costs are authored numbers. Nothing here measures whether Jev',
      'judges this site well.',
      '',
      'What it does show is mechanical and checkable: given the same judgements, the application',
      'that keeps the distribution can rank an alternative and price a probe, and the application',
      'that keeps only the argmax can do neither. Both facts are arithmetic on the numbers printed',
      'above. A generative model that emitted calibrated scores over the same candidate list would',
      'drive the same machinery just as well - the deficiency is in the single answer, not in the',
      'kind of model that produced it.',
    ],
    2,
  ),
);

console.log(
  `\n  ${dim(`site: ${Object.keys(SITE).length} pages, rendered to examples/site by src/site/render.ts`)}`,
);
