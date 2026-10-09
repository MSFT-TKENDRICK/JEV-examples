/**
 * Mechanics of the shared decision loop, with a fake client that answers from
 * each decision's scripted function. No model and no network.
 */
import assert from 'node:assert/strict';
import type { ExampleClient } from './client.ts';
import { BANNED_ROUTE_WORDS, decide, setField, type Decision, type Tally } from './decision-loop.ts';

let checks = 0;
const pass = (message: string) => {
  checks += 1;
  console.log(`PASS  ${message}`);
};
const silent = () => {};

function clientFor<R>(spec: Decision<R>): ExampleClient {
  const systemOne = async (request: { state: { observations: readonly string[] } }) => {
    const answer = spec.scripted(request.state.observations);
    const top = Object.entries(answer.distribution).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const answers: Record<string, unknown> = {
      route: { type: 'choice', choice: top, probabilities: answer.distribution },
    };
    for (const id of Object.keys(spec.indicators ?? {})) {
      answers[id] = { type: 'noul', noul: answer.indicators?.[id] ?? 0 };
    }
    return { model: 'fake', answers, usage: { input_tokens: 0, output_tokens: 0 } };
  };
  return { live: false, client: { systemOne } } as unknown as ExampleClient;
}

const FLAT: Tally = { a: 0.4, b: 0.3, c: 0.2, d: 0.1, none_of_these: 0 };
const SHARP: Tally = { a: 0.2, b: 0.8, c: 0, d: 0, none_of_these: 0 };
const OPTIONS = { a: 'option a', b: 'option b', c: 'option c', d: 'option d', none_of_these: 'none' };

interface Toy { flag: boolean; store: boolean; tag: string | null }

function toy(overrides: Partial<Decision<Toy>> & Pick<Decision<Toy>, 'scripted' | 'probes' | 'budget'>): Decision<Toy> {
  return {
    id: 'toy',
    title: 'toy',
    instructions: 'Pick one.',
    options: OPTIONS,
    record: { flag: false, store: true, tag: null },
    state: (r) => ({ flag: r.flag }),
    gate: () => null,
    plan: (option, record) => [
      setField<Toy>({ id: 'tag', description: 'tag', field: 'tag', value: option }),
    ],
    expect: { outcome: 'completed' },
    ...overrides,
  };
}

const probeFlag = {
  id: 'flag-read',
  cost: 1,
  description: 'read the flag',
  read: (r: Toy) => (r.flag ? 'set' : 'clear'),
  buckets: { set: ['b'], clear: ['a'] },
};

// 1. A probe changes the answer, and the changed answer is acted on.
{
  const spec = toy({
    probes: [probeFlag],
    budget: 3,
    scripted: (obs) => ({ distribution: obs.some((o) => o.endsWith(':set')) ? SHARP : FLAT }),
  });
  spec.record.flag = true;
  const result = await decide(spec, clientFor(spec), silent);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.probes.length, 1);
  assert.equal(result.flipped, true);
  assert.equal(result.leader, 'b');
  pass('a probe that changes the leader is bought, re-judged, and acted on');
}

// 2. A flat distribution with a spent budget refuses, and changes nothing.
{
  const spec = toy({
    probes: [{ ...probeFlag, cost: 2 }],
    budget: 1,
    scripted: () => ({ distribution: FLAT }),
  });
  const result = await decide(spec, clientFor(spec), silent);
  assert.equal(result.outcome, 'refused');
  assert.equal(result.probes.length, 0);
  assert.equal(spec.record.tag, null);
  assert.match(result.reason, /no affordable probe left/);
  pass('a flat distribution with no affordable probe refuses and leaves the record unchanged');
}

// 3. A confident answer that the deterministic gate rejects is refused.
{
  const spec = toy({
    probes: [],
    budget: 0,
    scripted: () => ({ distribution: SHARP }),
    gate: (record) => (record.store ? null : 'store is down'),
  });
  spec.record.store = false;
  const result = await decide(spec, clientFor(spec), silent);
  assert.equal(result.outcome, 'refused');
  assert.match(result.reason, /^gate: store is down/);
  assert.equal(spec.record.tag, null);
  pass('a confident answer is refused when the deterministic gate says no');
}

// 4. A failed verification rolls the completed steps back, in reverse.
{
  const spec = toy({
    probes: [],
    budget: 0,
    scripted: () => ({ distribution: SHARP }),
    plan: (option, record) => [
      setField<Toy>({ id: 'tag', description: 'tag', field: 'tag', value: option }),
      setField<Toy>({
        id: 'store-write',
        description: 'write to the store',
        field: 'tag',
        value: `${option}-stored`,
        healthy: (r) => r.store,
        unhealthyReason: 'the store is unavailable',
      }),
    ],
    expect: { outcome: 'rolled_back' },
  });
  spec.record.store = false;
  const result = await decide(spec, clientFor(spec), silent);
  assert.equal(result.outcome, 'rolled_back');
  assert.equal(spec.record.tag, null, 'the first step must be undone');
  assert.ok(result.steps.some((s) => s.id === 'tag' && s.compensated));
  pass('a failed verification rolls back the earlier steps and leaves the record as it was');
}

// 5. The contract's banned vocabulary does not appear in any option or outcome.
{
  for (const word of BANNED_ROUTE_WORDS) {
    for (const key of Object.keys(OPTIONS)) assert.ok(!key.includes(word), `${key} contains ${word}`);
  }
  pass('no option key in this loop names a banned route');
}

console.log(`\n${checks}/${checks} checks passed.`);
