/**
 * 11 — Content safety: deterministic rules first, then semantic policy checks.
 *
 * A rules engine runs before any model. A card number in a post is redacted by a
 * deterministic rule, and no request is built. Everything the rules do not settle
 * goes to Jev, with the policy clauses as the bounded options. Jev may flag personal
 * data about a third party. An opt-out request is accepted only when a rule also
 * matches the text. Policy linting uses the same pattern: Jev chooses a finding from
 * a fixed list.
 *
 * Claims: rules settle the cases they can match, before any model is asked. The
 * model's choice of clause is bounded to the policy's own list. A confident clause
 * that a rule does not confirm, for an opt-out, is refused.
 *
 * Must not claim: that any post is safe, unsafe, or in breach of a regulation.
 * The clause list is illustrative, not a policy. Rules match patterns and miss
 * others. Nothing is deleted or reported: visibility and suppression are reversible
 * flags. This is not a security boundary, and an injection-resistant detector is a
 * separate problem. Jev's distribution is not calibrated, and the fixtures are authored.
 *
 * Run: npm run fsi:content-safety
 */

import { pathToFileURL } from 'node:url';
import { createClient, isLiveJev } from '../../../src/client.ts';
import { fixtureBanner } from '../../../src/fixture-label.ts';
import {
  actOnRules,
  decide,
  NONE,
  printSummary,
  scriptFor,
  setField,
  type Decision,
  type ProbeSpec,
  type Result,
  type Tally,
} from '../../../src/decision-loop.ts';

interface PostRecord {
  postId: string;
  text: string;
  senderAgeDays: number;
  original: string | null;
  visibility: 'visible' | 'limited';
  suppressed: boolean;
  clause: string | null;
  lintFinding: string | null;
}

/** Card numbers: 13 to 16 digits, optionally grouped. Deliberately simple. */
const CARD_NUMBER = /\b(?:\d[ -]?){13,16}\b/;
/** Opt-out wording a rule can confirm. A model's opt-out label alone is not enough. */
const OPT_OUT = /\b(remove me|unsubscribe|stop (?:emailing|messaging|contacting) me|opt out)\b/i;

const CLAUSE: Record<string, string> = {
  'clause-4.1-guaranteed-returns': 'promises a guaranteed or fixed return',
  'clause-4.4-unsolicited-contact': 'contacts people who have not asked to hear from the sender',
  'clause-5.2-unsafe-financial-advice': 'tells readers to act on money without the caveats the policy requires',
  'clause-6.1-harassment-or-toxicity': 'targets a named person with insults, threats or demeaning language',
  'clause-7.3-impersonation': 'claims to be a bank employee, a regulator or a support agent',
  'request-opt-out': 'asks to stop receiving messages from the sender',
  [NONE]: 'no policy clause applies',
};

const LINT: Record<string, string> = {
  ambiguous_standard: 'a standard with no measurable test',
  missing_owner: 'no role is named as accountable',
  conflicts_with_clause: 'contradicts another clause in the same policy',
  [NONE]: 'no lint finding applies',
};

const SENDER_HISTORY: ProbeSpec<PostRecord> = {
  id: 'sender-history',
  cost: 1,
  description: 'check how long the sending account has existed',
  read: (r) => (r.senderAgeDays < 30 ? 'sender-new' : 'sender-established'),
  buckets: {
    'sender-new': ['clause-4.1-guaranteed-returns', 'clause-4.4-unsolicited-contact', 'clause-7.3-impersonation'],
    'sender-established': ['clause-5.2-unsafe-financial-advice', NONE],
  },
};

function post(overrides: Partial<PostRecord> & Pick<PostRecord, 'postId' | 'text'>): PostRecord {
  return {
    senderAgeDays: 400,
    original: null,
    visibility: 'visible',
    suppressed: false,
    clause: null,
    lintFinding: null,
    ...overrides,
  };
}

function policyDecision(record: PostRecord, probes: ProbeSpec<PostRecord>[], budget: number, scripted: Decision<PostRecord>['scripted'], expect: Decision<PostRecord>['expect']): Decision<PostRecord> {
  return {
    id: record.postId,
    title: `${record.postId} — ${record.text}`,
    instructions: 'Which policy clause, if any, does this post breach? Choose none_of_these if none applies.',
    options: CLAUSE,
    indicators: { contains_personal_data: 'the text includes personal data about a person other than the poster' },
    record,
    state: (r) => ({ text: r.text }),
    probes,
    budget,
    scripted,
    gate: (r, option) =>
      option === 'request-opt-out' && !OPT_OUT.test(r.text)
        ? 'an opt-out request needs wording a rule confirms, and the text has none'
        : null,
    plan: (option) => [
      setField<PostRecord>({ id: 'visibility', description: 'limit visibility pending the policy outcome', field: 'visibility', value: option === 'request-opt-out' ? 'visible' : 'limited' }),
      setField<PostRecord>({ id: 'clause', description: 'record the clause the post matched', field: 'clause', value: option }),
      setField<PostRecord>({ id: 'suppressed', description: 'suppress further messages to the opt-out sender', field: 'suppressed', value: option === 'request-opt-out' }),
    ],
    expect,
  };
}

function lintDecision(record: PostRecord): Decision<PostRecord> {
  return {
    id: record.postId,
    title: `${record.postId} — policy text: ${record.text}`,
    instructions: 'Which lint finding applies to this policy sentence? Choose none_of_these if none does.',
    options: LINT,
    record,
    state: (r) => ({ text: r.text }),
    probes: [],
    budget: 0,
    scripted: () => ({ distribution: { ambiguous_standard: 0.84, missing_owner: 0.08, conflicts_with_clause: 0.05, [NONE]: 0.03 } }),
    gate: () => null,
    plan: (option) => [
      setField<PostRecord>({ id: 'lint', description: 'annotate the sentence with the finding', field: 'lintFinding', value: option }),
    ],
    expect: { outcome: 'completed' },
  };
}

export function decisions(): Decision<PostRecord>[] {
  return [
    // The sender is new, and the probe that reads the account age is what changes the answer.
    policyDecision(
      post({
        postId: 'POST-914',
        text: 'Guaranteed 20% a month on crypto. DM me now and I will show you how.',
        senderAgeDays: 2,
      }),
      [SENDER_HISTORY],
      2,
      (obs) => {
        if (obs.includes('sender-history:sender-new')) {
          return { distribution: { 'clause-4.1-guaranteed-returns': 0.8, 'clause-4.4-unsolicited-contact': 0.1, 'clause-5.2-unsafe-financial-advice': 0.04, 'clause-7.3-impersonation': 0.04, [NONE]: 0.02 }, indicators: { contains_personal_data: 0.05 } };
        }
        return {
          distribution: { 'clause-4.4-unsolicited-contact': 0.44, 'clause-4.1-guaranteed-returns': 0.3, 'clause-5.2-unsafe-financial-advice': 0.12, 'clause-7.3-impersonation': 0.08, [NONE]: 0.06 },
          indicators: { contains_personal_data: 0.05 },
        };
      },
      { outcome: 'completed', flipped: true },
    ),
    // The rule and the model agree on an opt-out. The suppression flag is set.
    policyDecision(
      post({ postId: 'POST-921', text: 'Please remove me from your list, I never signed up for this.', senderAgeDays: 400 }),
      [SENDER_HISTORY],
      2,
      () => ({
        distribution: { 'request-opt-out': 0.91, 'clause-4.4-unsolicited-contact': 0.04, [NONE]: 0.03, 'clause-5.2-unsafe-financial-advice': 0.01, 'clause-6.1-harassment-or-toxicity': 0.01 },
        indicators: { contains_personal_data: 0.02 },
      }),
      { outcome: 'completed', flipped: false },
    ),
    // Flat, and the budget does not reach a probe that would settle it.
    policyDecision(
      post({ postId: 'POST-930', text: 'Some people say the fund is doing well, check the thread.', senderAgeDays: 500 }),
      [SENDER_HISTORY],
      1,
      () => ({
        distribution: { 'clause-4.4-unsolicited-contact': 0.3, 'clause-5.2-unsafe-financial-advice': 0.28, 'clause-6.1-harassment-or-toxicity': 0.2, [NONE]: 0.15, 'clause-4.1-guaranteed-returns': 0.07 },
        indicators: { contains_personal_data: 0.1 },
      }),
      { outcome: 'refused' },
    ),
  ];
}

export async function run(log: (line: string) => void = console.log): Promise<Result[]> {
  const results: Result[] = [];

  // Rules first. A card number is redacted before any model sees the text.
  const card = post({ postId: 'POST-901', text: 'Card 4111 1111 1111 1111 expires 09/28, can you check it?' });
  if (CARD_NUMBER.test(card.text)) {
    results.push(
      await actOnRules<PostRecord>({
        id: card.postId,
        title: `${card.postId} — card number in the text`,
        rule: 'card-number pattern matched',
        record: card,
        expect: { outcome: 'completed' },
        log,
        steps: [
          setField<PostRecord>({ id: 'original', description: 'keep the original text for reversal', field: 'original', value: card.text }),
          setField<PostRecord>({
            id: 'text',
            description: 'replace the card number with a placeholder',
            field: 'text',
            value: card.text.replace(CARD_NUMBER, '[card number removed]'),
          }),
        ],
      }),
    );
  }

  for (const decision of decisions()) {
    results.push(await decide(decision, createClient(scriptFor(decision)), log));
  }

  // Policy linting uses the same decision loop over a different list.
  const lint = post({ postId: 'POLICY-P-17', text: 'Customers may be refunded where appropriate.' });
  const lintSpec = lintDecision(lint);
  results.push(await decide(lintSpec, createClient(scriptFor(lintSpec)), log));
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  fixtureBanner(isLiveJev());
  printSummary(await run());
}
