/**
 * 04 - Browser use: a maze a point estimate cannot walk.
 *
 * There is no official TypeSafe browser-use example. The architecture below is
 * the one the best community implementations converge on, and it follows from
 * what Jev is: a model that picks from options you supply and never writes free
 * text.
 *
 * The loop is in `src/site/walk.ts`. What matters here is what it does when the
 * distribution is flat, because that is the only interesting question a browser
 * agent ever faces:
 *
 *   probe     run the read-only peek with the best expected information gain
 *             per unit cost, update the posterior, decide again
 *   act       navigate, or resume from the best surviving alternative, or -
 *             once and only once the belief has concentrated - commit
 *   refuse    stop, say why, having changed nothing
 *
 * Uncertainty selects the next machine action. It never selects a person.
 * There is no queue, no approval, no shortlist handed to somebody else. A run
 * that cannot proceed ends; it does not become someone's ticket.
 *
 * Three fixtures, each showing a different one of those:
 *
 *   A  the confident first click is wrong. Three pages later the site proves
 *      it. The run resumes from the alternative the distribution ranked
 *      second - and that alternative is exactly the probability mass an argmax
 *      interface discards at the branch point.
 *   B  the leader is wrong and cheap peeking says so. Probes chosen by expected
 *      information gain move the decision from "Invoices & receipts" to
 *      "Billing history" before a single page is loaded.
 *   C  nothing discriminates. The peeks return nothing usable, the budget goes,
 *      and the run refuses - terminal, not a handoff.
 *
 * Honesty: the site, its confusable labels, its probe costs and its dead ends
 * are all authored, in `src/site/graph.ts`. Offline runs script Jev's answers
 * through `src/mock-fetch.ts`, which exercises the real SDK code path with
 * manufactured HTTP responses. This example demonstrates what the application
 * does with a distribution. It is not evidence that the distribution is right.
 *
 * Run:  node examples/04-browser-use.ts
 */

import { eigIsDegenerate } from '../src/information-gain.ts';
import { backendLabel, createClient } from '../src/client.ts';
import type { SiteScript } from '../src/site/judges.ts';
import { createJevJudge } from '../src/site/judges.ts';
import type { WalkEvent, WalkResult } from '../src/site/walk.ts';
import { walk } from '../src/site/walk.ts';
import { TASK } from '../src/site/graph.ts';
import { banner, bold, cyan, dim, green, note, pct, red, title, yellow } from '../src/ui.ts';

// ---------------------------------------------------------------------------
// Fixtures. Every `target` is an explicit distribution, because the whole
// difficulty of this site is that several labels are genuinely close and the
// mass has to be able to sit on two of them at once.
// ---------------------------------------------------------------------------

/** A: confident, and confidently wrong. */
const CONFIDENT: SiteScript = {
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

/** B and C: torn between the two closest labels, and leaning the wrong way. */
const TORN: SiteScript = {
  ...CONFIDENT,
  home: {
    target: {
      distribution: { e1: 0.09, e2: 0.05, e3: 0.04, e4: 0.03, e5: 0.29, e6: 0.37, none: 0.13 },
    },
    goalMet: { noul: 0.01 },
    atTarget: { noul: 0.05 },
    deadEnd: { noul: 0.02 },
  },
};

interface Scenario {
  key: string;
  name: string;
  script: SiteScript;
  observations?: Record<string, string>;
  point: readonly string[];
}

const scenarios: readonly Scenario[] = [
  {
    key: 'A',
    name: 'the confident click is wrong',
    script: CONFIDENT,
    point: [
      'The run takes the highest-mass branch, is proven wrong three pages in, and resumes from the',
      'alternative the distribution ranked second. That alternative is a piece of the distribution.',
      'An interface that returns one answer never produced it, so there is nothing to return to.',
    ],
  },
  {
    key: 'B',
    name: 'probing changes the answer',
    script: TORN,
    point: [
      'The leading label is the wrong one. Read-only peeks, chosen by expected information gain per',
      'unit cost, move the mass onto a different link before any page is loaded. The probe changed',
      'the decision; it was not reported alongside a decision already taken.',
    ],
  },
  {
    key: 'C',
    name: 'nothing discriminates, so the run refuses',
    script: TORN,
    observations: {
      'badge-counts': 'unknown',
      'disabled-state': 'unknown',
      breadcrumb: 'unknown',
      'footer-legend': 'unknown',
    },
    point: [
      'This account renders none of the metadata the peeks read, so every observation comes back',
      '`unknown` and the posterior falls back to the prior. The budget goes, nothing separates the',
      'candidates, and the run stops having changed nothing. Terminal - not a queue, not an',
      'approval, not a person.',
    ],
  },
];

// ---------------------------------------------------------------------------

function distribution(values: Readonly<Record<string, number>>): string {
  return Object.entries(values)
    .filter(([, mass]) => mass > 0.005)
    .sort(([, a], [, b]) => b - a)
    .map(([id, mass]) => `${id} ${mass.toFixed(2)}`)
    .join('  ');
}

function render(event: WalkEvent): void {
  switch (event.type) {
    case 'arrive': {
      console.log(
        `\n  ${bold(`step ${event.step}`)}  ${cyan(event.site.file)}  ` +
          dim(
            `${event.site.elements.length} candidate${event.site.elements.length === 1 ? '' : 's'} · ~${event.tokens} tokens of page state`,
          ),
      );
      console.log(`    ${dim(event.site.text.slice(0, 100))}`);
      break;
    }
    case 'judged': {
      console.log(`    ${dim('belief ')} ${distribution(event.prior)}`);
      console.log(
        `    ${dim(
          `goalMet ${pct(event.signals.goalMet)} · atTarget ${pct(event.signals.atTarget)} · ` +
            `deadEnd ${pct(event.signals.deadEnd)}`,
        )}`,
      );
      break;
    }
    case 'probe': {
      const ranked = event.run.ranked
        .map(
          (entry) =>
            `${entry.probe.id} ${entry.expectedInformationGain.toFixed(3)}/${entry.probe.cost}`,
        )
        .join(', ');
      console.log(
        `    ${yellow('probe  ')} ${event.run.probeId} ` +
          dim(`cost ${event.run.cost}, EIG ${event.run.expectedInformationGain.toFixed(3)}`),
      );
      console.log(`    ${dim(`         considered gain/cost ${ranked}`)}`);
      console.log(
        `    ${dim(`         saw "${event.run.observation}" ->`)} ${distribution(event.run.after)}`,
      );
      break;
    }
    case 'navigate': {
      console.log(
        `    ${green('click  ')} "${event.label}" ` +
          dim(`${pct(event.probability)} -> ${event.to}`),
      );
      break;
    }
    case 'deadEnd': {
      console.log(`    ${red('dead end')} ${dim(event.proof)}`);
      break;
    }
    case 'backtrack': {
      console.log(
        `    ${yellow('resume ')} "${event.run.via[event.run.via.length - 1] ?? event.run.to}" ` +
          dim(`path probability ${event.run.alternativeMass.toFixed(4)}`),
      );
      console.log(`    ${dim(`         ${event.run.reason}`)}`);
      break;
    }
    case 'commit': {
      console.log(`    ${green('commit ')} "${event.label}" ` + dim(pct(event.probability)));
      for (const step of event.plan.steps) {
        console.log(`    ${dim(`         ${step.id}: ${step.detail}`)}`);
      }
      console.log(`    ${dim(`         plan outcome: ${event.plan.outcome}`)}`);
      break;
    }
    case 'refuse': {
      console.log(`    ${red(`refuse `)} ${event.status}`);
      console.log(note(event.reason, 13));
      break;
    }
    case 'complete': {
      console.log(`    ${green('done   ')} ${dim(event.reason)}`);
      break;
    }
    case 'route':
      break;
  }
}

function summarise(result: WalkResult): void {
  console.log(
    `\n  ${bold('outcome')} ${result.status}  ` +
      dim(
        `${result.steps} pages · ${result.judgeCalls} Jev requests · ` +
          `${result.probes.length} probes costing ${result.budgetSpent} of ` +
          `${result.budgetSpent + result.budgetLeft} · ${result.backtracks.length} backtrack(s)`,
      ),
  );
  console.log(
    `  ${dim(
      `frontier ${result.frontier.open} open, ${result.frontier.dead} dead, ` +
        `${result.frontier.pruned} pruned holding ${result.frontier.prunedMass.toFixed(4)} ` +
        `of path mass, beam width ${result.frontier.beamWidth}`,
    )}`,
  );
}

// ---------------------------------------------------------------------------

title('04 - Browser use: pick an element, never invent one');
const { live } = createClient();
banner(live);

for (const scenario of scenarios) {
  const judge = createJevJudge({ script: scenario.script });

  console.log(`\n${bold(`${scenario.key}. ${live ? `live ${backendLabel()} on the example site` : scenario.name}`)}`);
  console.log(`  ${dim(TASK)}`);

  const result = await walk({
    judge,
    ...(scenario.observations === undefined ? {} : { observations: scenario.observations }),
    onEvent: render,
  });

  summarise(result);
  if (!live) console.log(note(scenario.point, 2));
}

// ---------------------------------------------------------------------------

console.log(`\n${bold('why a distribution and not an answer')}`);
console.log(
  note(
    [
      'The distribution ranks alternatives for backtracking, if this run needs them. A resumed path',
      'comes from mass the run was told about and kept. Collapse the same page to a single',
      'answer and that alternative does not exist to return to: the beam is one wide, the first dead',
      'end is the last page, and the run ends where the maze says it ends.',
      '',
      'The same collapse disables probing. Expected information gain over a point mass is exactly',
      'zero for every probe, because H(P) = 0 and the posterior of a point mass is that same point',
      `mass. eigIsDegenerate({ e5: 1 }) === ${String(eigIsDegenerate({ e5: 1 }))}. An argmax agent does not find probe`,
      'selection harder; it finds every probe equally worthless. Example 06 runs that arm.',
    ],
    2,
  ),
);
