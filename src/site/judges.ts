/**
 * The decision models the walk can be driven by.
 *
 * Both arms in example 06 come from here, so the difference between them is a
 * difference in what the model returns and nothing else. Same site, same loop,
 * same click mechanics.
 */

import { createClient } from '../client.ts';
import type { ScriptedAnswer } from '../mock-fetch.ts';
import { buildQuestions } from '../browser-policy.ts';
import type { Signals } from '../browser-policy.ts';
import type { SitePage } from './graph.ts';
import type { Judge } from './walk.ts';

/** Scripted answers per page id, for the offline fixtures. */
export type SiteScript = Record<string, Record<string, ScriptedAnswer>>;

export interface JevJudgeOptions {
  script: SiteScript;
  beamWidth?: number;
  label?: string;
}

/**
 * Jev as the decision model.
 *
 * One request per page. `answers.target.probabilities` is the whole point: the
 * distribution over the page's real elements, carried forward into the frontier
 * and updated by probes, rather than collapsed to `answers.target.choice`.
 */
export function createJevJudge(options: JevJudgeOptions): Judge & { live: boolean } {
  const beamWidth = options.beamWidth ?? 3;
  let live = false;

  return {
    label: options.label ?? 'Jev',
    detail: `distribution over page elements, beam width ${beamWidth}`,
    beamWidth,
    get live() {
      return live;
    },
    async judge(site: SitePage, history: readonly string[]) {
      const questions = buildQuestions(site.elements);
      const scripted = options.script[site.id] ?? {};
      const { client, live: isLive } = createClient(() => scripted);
      live = isLive;

      const { answers } = await client.systemOne({
        state: {
          task: site.title,
          url: site.file,
          visibleText: site.text,
          candidates: Object.fromEntries(
            site.elements.map((element) => [element.id, `${element.role}: ${element.label}`]),
          ),
          stepsTaken: [...history],
        },
        questions,
      });

      const signals: Signals = {
        goalMet: answers.goalMet.noul,
        atTarget: answers.atTarget.noul,
        deadEnd: answers.deadEnd.noul,
      };

      return { prior: { ...answers.target.probabilities }, signals };
    },
  };
}
