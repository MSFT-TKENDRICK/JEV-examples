/**
 * The Jev decision model used by browser examples 04-06.
 *
 * The independent generative control in src/control-agent.ts implements the
 * same Judge interface: same site, loop and click mechanics.
 */

import { createClient, isLiveJev } from '../client.ts';
import type { ScriptedAnswer } from '../mock-fetch.ts';
import { buildQuestions } from '../browser-policy.ts';
import type { Signals } from '../browser-policy.ts';
import type { SitePage } from './graph.ts';
import type { Judge } from './walk.ts';
import { describe } from './walk.ts';

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
  const live = isLiveJev();

  return {
    label: options.label ?? 'Jev',
    detail: `distribution over page elements, beam width ${beamWidth}`,
    beamWidth,
    live,
    async judge(site: SitePage, history: readonly string[]) {
      const questions = buildQuestions(site.elements);
      const { client } = createClient(() => options.script[site.id] ?? {});

      const { answers } = await client.systemOne({
        state: describe(site, history),
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
