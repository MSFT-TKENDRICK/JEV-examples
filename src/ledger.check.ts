/**
 * Regression guard for the decision ledger.
 *
 * Every check here corresponds to a defect found in review. Two were serious
 * enough to be worth naming: caller input could overwrite `mode` (letting a
 * scripted run emit records labelled `LIVE_API`), and `metricsFor` reported a
 * one-option or empty distribution as maximally confident, so an entropy/margin
 * policy auto-approved exactly the malformed responses it existed to catch.
 *
 * Run with `npm run check:foundation`.
 */
import { createLedger, metricsFor, hashState, stateReference } from './ledger.ts';
import { fixtureMarkdown } from './fixture-label.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// 1. BLOCKING: caller input must not be able to relabel a scripted run as live.
const ledger = createLedger({ component: 'check', mode: 'SCRIPTED_MOCK' });
const hostile = {
  mode: 'LIVE_API',
  decisionId: 'attacker-chosen',
  runId: 'attacker-run',
  component: 'spoofed',
  state: stateReference({ a: 1 }),
  candidates: { source: 's', version: 'v', optionIds: ['x', 'y'], readAt: 'now' },
  policy: { policyVersion: 'p', thresholds: {}, route: 'auto', reason: 'r' },
  executed: { action: 'x' },
  latencyMs: 1,
} as unknown as Parameters<typeof ledger.record>[0];
const spoofed = ledger.record(hostile);
check('mode cannot be overwritten by caller', spoofed.mode === 'SCRIPTED_MOCK', spoofed.mode);
check('decisionId cannot be overwritten', spoofed.decisionId !== 'attacker-chosen');
check('component cannot be overwritten', spoofed.component === 'check', spoofed.component);

// 2. BLOCKING: degenerate distributions must not look confident.
const policyWouldAutoApprove = (m: { normalizedEntropy: number; margin: number }) =>
  m.normalizedEntropy <= 0.3 && m.margin >= 0.4;
const single = metricsFor({ freeze: 1 }, 'freeze', ['freeze']);
const empty = metricsFor({}, 'anything', ['a', 'b', 'c']);
check('single-option set is not auto-approved', !policyWouldAutoApprove(single), JSON.stringify(single));
check('empty distribution is not auto-approved', !policyWouldAutoApprove(empty), JSON.stringify(empty));
check('offered count beats returned count', metricsFor({ a: 0.9, b: 0.1 }, 'a', ['a', 'b', 'c', 'd']).optionCount === 4);

// 3. Unknown selected key must throw rather than silently report 0.
try {
  metricsFor({ a: 0.9, b: 0.1 }, 'freeze_card', ['a', 'b']);
  check('unknown selected key throws', false);
} catch {
  check('unknown selected key throws', true);
}

// 4. canonical(): distinct states must not collide.
const d1 = hashState({ at: new Date('2024-01-01T00:00:00Z') });
const d2 = hashState({ at: new Date('2025-06-01T00:00:00Z') });
check('distinct Dates hash differently', d1 !== d2);
check('key order does not matter', hashState({ a: 1, b: 2 }) === hashState({ b: 2, a: 1 }));
for (const [name, value] of [
  ['bigint', { v: 1n }],
  ['Map', { v: new Map([['a', 1]]) }],
  ['NaN', { v: NaN }],
] as const) {
  try {
    hashState(value as Record<string, unknown>);
    check(`${name} is rejected`, false);
  } catch {
    check(`${name} is rejected`, true);
  }
}
const cyclic: Record<string, unknown> = {};
cyclic['self'] = cyclic;
try {
  hashState(cyclic);
  check('cycle is rejected', false);
} catch (e) {
  check('cycle is rejected', e instanceof Error && e.message.includes('cyclic'));
}

// 5. Divergence is derived, not asserted.
const base = {
  state: stateReference({ a: 1 }),
  candidates: { source: 's', version: 'v', optionIds: ['x', 'y'], readAt: 'now' },
  policy: { policyVersion: 'p', thresholds: {}, route: 'auto', reason: 'r' },
  latencyMs: 1,
};
const agreed = ledger.record({ ...base, recommendation: { question: 'q', choice: 'x' }, executed: { action: 'x' } });
const diverged = ledger.record({ ...base, recommendation: { question: 'q', choice: 'x' }, executed: { action: 'y' } });
const noRec = ledger.record({ ...base, executed: { action: 'y' } });
check('agreement derives false', agreed.executed.divergedFromRecommendation === false);
check('divergence derives true', diverged.executed.divergedFromRecommendation === true);
check('no recommendation is not divergence', noRec.executed.divergedFromRecommendation === false);
check(
  'optional fields default to empty or null',
  agreed.metrics === null && agreed.execution === null && agreed.failure === null,
);
check('the probe trail defaults to empty rather than null', Array.isArray(agreed.probes) && agreed.probes.length === 0);

const probed = ledger.record({
  ...base,
  recommendation: { question: 'q', choice: 'x' },
  executed: { action: 'x' },
  probes: [
    {
      probeId: 'check-thing',
      expectedInformationGain: 0.42,
      priorEntropy: 0.69,
      observation: 'absent',
      posteriorEntropy: 0.11,
      costUnits: 1,
    },
  ],
  execution: { outcome: 'completed', reason: 'done', stepsAttempted: 2, stepsVerified: 2 },
});
check('a probe trail round-trips', probed.probes[0]?.probeId === 'check-thing');
check('an execution outcome round-trips', probed.execution?.outcome === 'completed');

// 6. JSONL round-trips, and entries() is not aliased.
const jsonl = ledger.toJsonl();
check('jsonl ends with newline', jsonl.endsWith('\n'));
check(
  'jsonl round-trips',
  jsonl.trimEnd().split('\n').length === ledger.entries().length &&
    jsonl.trimEnd().split('\n').every((l) => JSON.parse(l).runId === ledger.runId),
);
const snapshot = ledger.entries();
(snapshot as unknown as unknown[]).push('junk');
check('entries() returns a copy', ledger.entries().length !== snapshot.length);

// 7. Markdown disclosure must not swallow following prose.
check('fixtureMarkdown ends with a blank line', fixtureMarkdown(false).endsWith('\n\n') && fixtureMarkdown(true).endsWith('\n\n'));

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
