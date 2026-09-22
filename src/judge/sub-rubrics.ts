/**
 * Sub-rubrics: the probes for example 02.
 *
 * The premise is that a flat distribution on "is this answer good?" usually
 * means the question was too coarse. `factual` — "how well does the response
 * match the policy?" — bundles at least three separable things: whether the
 * headline number is right, whether the conditions attached to it survived, and
 * whether the next step it names is one the policy actually authorises. A
 * response can get the first right and the second badly wrong, and a single
 * four-level rubric has no way to say so except by landing in the middle.
 *
 * So when the parent dimension leaves the verdict undecided, the judge asks a
 * narrower question instead of finding a person. Each sub-rubric below is
 * strictly narrower than its parent, is read-only with respect to the candidate
 * (it inspects the same text; it changes nothing), and costs one extra request.
 *
 * On `cost`: the unit is one round trip, scaled by how much of the reference
 * the question requires re-reading. `exception-preserved` is set higher because
 * it has to compare against the conditional clauses rather than a single
 * number. **These numbers are authored.** They are not measurements of latency
 * or tokens, and the ranking between probes can change if you change them. What
 * the example demonstrates is that the selection responds to them correctly,
 * not that they are right.
 *
 * `buckets` maps an observation to the verdicts it is consistent with. That
 * mapping is authored too. `partitionProbe` treats an unlisted candidate as
 * uninformative rather than impossible, so an omission degrades a probe's
 * apparent value instead of silently zeroing a verdict.
 */

import { score } from '@typesafe-ai/sdk';
import type { ScoreQuestion } from '@typesafe-ai/sdk';
import { partitionProbe, type Probe } from '../information-gain.ts';
import type { Verdict } from '../rubric.ts';

export interface SubRubric {
  id: string;
  /** One line, for the trail. */
  description: string;
  cost: number;
  question: ScoreQuestion;
  /** Observation name per rubric level, index-aligned with the question's criteria. */
  observationAt: readonly string[];
  /** Observation -> the verdicts that observation is consistent with. */
  buckets: Readonly<Record<string, readonly Verdict[]>>;
}

/**
 * Sub-rubrics that sharpen `factual`. Each level description stands on its own,
 * because the model sees the level descriptions and nothing else.
 */
export const factualSubRubrics: readonly SubRubric[] = [
  {
    id: 'window-stated',
    description: 'Is the headline refund window itself stated correctly?',
    cost: 1,
    question: score('Does `response` state the refund window given in `reference` correctly?', [
      'States a different window, or states no window at all',
      'Gestures at a window without committing to the number',
      'States the reference window exactly',
    ]),
    observationAt: ['wrong-window', 'window-implied', 'window-exact'],
    buckets: {
      'wrong-window': ['fail'],
      'window-implied': ['investigate', 'fail'],
      'window-exact': ['pass', 'investigate'],
    },
  },
  {
    id: 'exception-preserved',
    description: 'Do the conditions that gate the exception survive?',
    cost: 1.6,
    question: score(
      'Does `response` preserve the conditions `reference` attaches to its exceptions?',
      [
        'Presents an exception as unconditional, dropping the conditions entirely',
        'Mentions that exceptions exist but not what gates them',
        'Reproduces the gating conditions',
      ],
    ),
    observationAt: ['conditions-dropped', 'conditions-vague', 'conditions-kept'],
    buckets: {
      'conditions-dropped': ['fail'],
      'conditions-vague': ['investigate', 'fail'],
      'conditions-kept': ['pass'],
    },
  },
  {
    id: 'step-authorised',
    description: 'Is the next step it names one the policy actually authorises?',
    cost: 1,
    question: score('Is the next step named by `response` authorised by `reference`?', [
      'Names a step `reference` does not authorise',
      'Names no next step at all',
      'Names exactly the step `reference` authorises',
    ]),
    observationAt: ['step-unsupported', 'step-absent', 'step-authorised'],
    buckets: {
      'step-unsupported': ['fail'],
      'step-absent': ['investigate', 'fail'],
      'step-authorised': ['pass', 'investigate'],
    },
  },
];

/** Turns a sub-rubric's buckets into a probe over the verdict candidates. */
export function subRubricProbe(rubric: SubRubric): Probe {
  return partitionProbe(rubric.id, rubric.cost, rubric.buckets, rubric.description);
}

export function probesFor(rubrics: readonly SubRubric[]): Probe[] {
  return rubrics.map(subRubricProbe);
}

export function subRubricById(rubrics: readonly SubRubric[], id: string): SubRubric {
  const found = rubrics.find((rubric) => rubric.id === id);
  if (found === undefined) throw new Error(`No sub-rubric named "${id}"`);
  return found;
}

/** Maps the level the model put most mass on to this sub-rubric's observation. */
export function observationFor(rubric: SubRubric, level: number): string {
  const observation = rubric.observationAt[level];
  if (observation === undefined) {
    throw new Error(`Sub-rubric "${rubric.id}" has no observation for level ${level}`);
  }
  return observation;
}
