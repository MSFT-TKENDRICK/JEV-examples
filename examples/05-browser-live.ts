/**
 * 05 - The same loop, against a real browser.
 *
 * Example 04 walks the maze offline. This one walks it in Chrome, over CDP,
 * against the HTML in `examples/site` - and it does so by handing the *same*
 * `walk()` a driver. The decision code does not know which it is running
 * against. Nothing about the policy, the probe selection, the beam or the
 * commit gate is duplicated here.
 *
 * Two safeguards keep that claim honest:
 *
 *   - every page is described from the DOM and compared against the graph. A
 *     mismatch throws rather than degrading to the fixture.
 *   - the probes read `data-peek`, which indexes evidence the page genuinely
 *     renders, and the form steps verify by reading values back out of the
 *     live inputs.
 *
 * The recording is evidence, not decoration: it is what a reader gets instead
 * of taking the console output on trust. If ffmpeg is unavailable the run still
 * happens and the missing video is reported.
 *
 *   node examples/05-browser-live.ts             record to docs/media
 *   node examples/05-browser-live.ts --no-video  drive a visible browser only
 *
 * With `TYPESAFE_API_KEY` set the judgements are real Jev calls. Without one
 * they are scripted through `src/mock-fetch.ts` and the browser half is still
 * entirely real.
 */

import { resolve } from 'node:path';

import { openSession } from '../src/browser-driver.ts';
import { createClient } from '../src/client.ts';
import type { SiteScript } from '../src/site/judges.ts';
import { createJevJudge } from '../src/site/judges.ts';
import type { WalkEvent } from '../src/site/walk.ts';
import { walk } from '../src/site/walk.ts';
import { TASK } from '../src/site/graph.ts';
import { banner, bold, cyan, dim, green, note, pct, red, title, yellow } from '../src/ui.ts';

/**
 * The run worth filming: confident, wrong, and recoverable.
 *
 * The agent clicks the wrong link with 0.62 of the mass behind it, walks three
 * pages into an archive that proves the branch finished, returns to the account
 * page and takes the alternative it had kept. Then two probes on the billing
 * page separate three near-identical charges, and only then does it submit.
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

function render(event: WalkEvent): void {
  switch (event.type) {
    case 'arrive':
      console.log(`\n  ${bold(`step ${event.step}`)}  ${cyan(event.site.file)}`);
      break;
    case 'verified':
      console.log(`    ${dim(`dom     ${event.detail}`)}`);
      break;
    case 'judged':
      console.log(
        `    ${dim('belief ')} ` +
          Object.entries(event.prior)
            .filter(([, mass]) => mass > 0.005)
            .sort(([, a], [, b]) => b - a)
            .map(([id, mass]) => `${id} ${mass.toFixed(2)}`)
            .join('  '),
      );
      break;
    case 'probe':
      console.log(
        `    ${yellow('probe  ')} ${event.run.probeId} ` +
          dim(
            `cost ${event.run.cost}, EIG ${event.run.expectedInformationGain.toFixed(3)}, ` +
              `page returned "${event.run.observation}"`,
          ),
      );
      break;
    case 'navigate':
      console.log(`    ${green('click  ')} "${event.label}" ${dim(pct(event.probability))}`);
      break;
    case 'deadEnd':
      console.log(`    ${red('dead end')} ${dim(event.proof)}`);
      break;
    case 'backtrack':
      console.log(
        `    ${yellow('resume ')} replaying to "${event.run.to}" ` +
          dim(`path probability ${event.run.alternativeMass.toFixed(4)}`),
      );
      break;
    case 'commit':
      console.log(`    ${green('commit ')} "${event.label}" ${dim(pct(event.probability))}`);
      for (const step of event.plan.steps) console.log(`    ${dim(`         ${step.detail}`)}`);
      break;
    case 'refuse':
      console.log(`    ${red('refuse ')} ${event.status} ${dim(event.reason)}`);
      break;
    case 'complete':
      console.log(`    ${green('done   ')} ${dim(event.reason)}`);
      break;
    default:
      break;
  }
}

const record = !process.argv.includes('--no-video');
const outputPath = resolve(import.meta.dirname, '..', 'docs', 'media', 'browser-use.mp4');

title('05 - The same loop, against a real browser');
const { live } = createClient();
banner(live);
console.log(`\n  ${dim(TASK)}`);

const judge = createJevJudge({ script: SCRIPT, beamWidth: 3 });
const session = await openSession({
  label: 'Jev',
  detail: live ? 'live judgements, beam width 3' : 'scripted judgements, beam width 3',
  ...(record ? { outputPath } : {}),
});

const startedAt = Date.now();
let video: string | null = null;

try {
  const result = await walk({ judge, driver: session, onEvent: render });

  console.log(
    `\n  ${bold('outcome')} ${result.status}  ` +
      dim(
        `${result.steps} pages · ${result.judgeCalls} requests · ` +
          `${result.probes.length} probes costing ${result.budgetSpent} · ` +
          `${result.backtracks.length} backtrack(s) · ${Date.now() - startedAt}ms wall clock`,
      ),
  );
  video = await session.close(result.status === 'goal_reached' ? 'done' : result.status);
} catch (error) {
  video = await session.close('run failed');
  throw error;
}

console.log(
  note(
    video === null
      ? [
          'No video was written. The run above still happened in a real browser; only the',
          'recording is missing. webreel downloads ffmpeg on first use and that fetch can fail -',
          'set FFMPEG_PATH to an existing binary and run again.',
        ]
      : [
          `Recording written to ${video}.`,
          '',
          'Everything in it is real Chrome: real page loads from examples/site, the cursor moving',
          'to the element the policy chose, real typing into the re-issue form and values read back',
          'out of the DOM. The navigation itself follows the element\'s own href rather than a',
          'synthetic coordinate click, because a coordinate click fires twice across a page load.',
          'What is scripted offline is the judgement at each page, and the site itself was written',
          'to be hard. The video is evidence of what the application does with a distribution - not',
          'evidence that the distribution deserves trust.',
        ],
    2,
  ),
);
