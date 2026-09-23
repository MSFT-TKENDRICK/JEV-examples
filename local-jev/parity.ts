/**
 * Runs the real local model behind the proxy and checks it through the TypeSafe SDK:
 *
 *   1. reference parity — the Python reference output that @receptron/laya's own
 *      test pins (rl_agent_api.RLAgent.system_one), reproduced through proxy + SDK;
 *   2. wire invariants on choice / score / noul answers;
 *   3. limit handling — input over Laya's trained 512/192 tokens runs at an extended
 *      context (the default LOCAL_JEV_OVERFLOW=extend); input the model still could
 *      not see is refused with 422, never silently cut;
 *   4. latency and memory on this machine.
 *
 * This measures parity with Laya's reference and with Jev's wire contract. It
 * does not, and cannot, measure agreement with Jev's answers.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import { choice, noul, score, TypeSafeClient, UnprocessableEntityError } from '@typesafe-ai/sdk';
import { startLocalJev } from './main.ts';

const close = (a: number, b: number, tol = 1e-4) => Math.abs(a - b) <= tol;
const sum = (values: Record<string, number>) => Object.values(values).reduce((s, v) => s + v, 0);

process.env['LOCAL_JEV_OVERFLOW'] = 'extend';
const started = performance.now();
const proxy = await startLocalJev({ port: 0 });
const loadMs = Math.round(performance.now() - started);
const client = new TypeSafeClient({ apiKey: 'local', baseURL: proxy.url, defaultModel: 'local-laya', timeout: 180_000, retry: { maxRetries: 0 } });

try {
  const reference = await client.systemOne({
    state: {
      subject: 'Refund not received',
      body: 'I cancelled my subscription two weeks ago and I still have not received my refund. This is the third time I am writing. If this is not resolved I will dispute the charge with my bank.',
    },
    questions: {
      department: choice('Which team should handle this ticket?', {
        billing: 'payments, refunds, invoices',
        support: 'product help and bugs',
        sales: 'new purchases and upgrades',
      }),
      urgency: score('How urgent is this ticket?', ['not urgent', 'somewhat urgent', 'urgent', 'critical']),
      churn_risk: noul('Is the customer likely to cancel or dispute?'),
    },
  });
  assert.equal(reference.usage.input_tokens, 267);
  assert.equal(reference.answers.department.choice, 'billing');
  assert.deepEqual(reference.answers.department.probabilities, { billing: 0.9415, support: 0.031, sales: 0.0275 });
  assert.equal(reference.answers.department.confidence, 0.7603);
  assert.equal(reference.answers.urgency.score, 1.3886);
  assert.deepEqual(reference.answers.urgency.probabilities, { 0: 0.1752, 1: 0.2947, 2: 0.4962, 3: 0.0338 });
  assert.equal(reference.answers.churn_risk.noul, 0.0988);
  console.log(`PASS  reproduces the Laya Python reference exactly through proxy + SDK (model ${reference.model})`);

  const battery = await client.systemOne({
    state: 'Card ending 4411 was charged twice for the same grocery order yesterday. Customer wants one charge reversed today.',
    questions: {
      route: choice('Which queue should take this case?', {
        disputes: 'card disputes and chargebacks',
        fraud: 'unauthorised or suspicious activity',
        payments: 'duplicate or failed payments',
        general: null,
      }),
      severity: score('How severe is the customer impact?', { 0: 'none', 1: 'minor', 2: 'moderate', 3: 'major', 4: 'critical' }),
      duplicate: noul('Is this a duplicate charge?', { true: 'the same purchase was charged more than once', false: null }),
      fraud: noul('Does the customer report unauthorised use?'),
    },
  });
  const { route, severity, duplicate, fraud } = battery.answers;
  assert.ok(close(sum(route.probabilities), 1, 5e-4));
  assert.equal(route.choice, Object.entries(route.probabilities).sort((a, b) => b[1] - a[1])[0]![0]);
  assert.ok(route.confidence >= 0 && route.confidence <= 1);
  assert.ok(close(sum(severity.probabilities), 1, 5e-4));
  const expected = Object.entries(severity.probabilities).reduce((s, [level, p]) => s + Number(level) * p, 0);
  assert.ok(close(severity.score, expected, 2e-3));
  assert.deepEqual(severity.legend, { 0: 'none', 1: 'minor', 2: 'moderate', 3: 'major', 4: 'critical' });
  assert.ok(duplicate.noul >= 0 && duplicate.noul <= 1 && fraud.noul >= 0 && fraud.noul <= 1);
  console.log(
    `PASS  wire invariants hold on a live battery: route=${route.choice} (${route.probabilities[route.choice]}), ` +
      `severity=${severity.score}, duplicate=${duplicate.noul}, fraud=${fraud.noul}`,
  );

  const long = await client
    .systemOne({ state: 'lorem ipsum dolor sit amet '.repeat(200), questions: { spam: noul('Is this spam?') } })
    .asResponse();
  assert.equal(long.headers.get('x-local-jev-overflow'), 'extended');
  await assert.rejects(
    () =>
      client.systemOne({
        state: 'short',
        questions: { pick: choice('Pick one', { terse: null, verbose: 'a very long description of this option that keeps going '.repeat(8) }) },
      }),
    (error: unknown) => error instanceof UnprocessableEntityError && /48-token per-option cap/.test(error.message),
  );
  await assert.rejects(
    () => client.systemOne({ state: 'lorem ipsum dolor sit amet '.repeat(2000), questions: { spam: noul('Is this spam?') } }),
    (error: unknown) => error instanceof UnprocessableEntityError && /8192-token limit/.test(error.message),
  );
  console.log(
    `PASS  over-length state runs at context ${long.headers.get('x-local-jev-context')} (${long.headers.get('x-local-jev-overflow')}); ` +
      'over-cap options and over-encoder input are refused with 422, never silently cut',
  );

  const time = async (questions: Parameters<typeof client.systemOne>[0]['questions'], runs: number) => {
    const samples: number[] = [];
    await client.systemOne({ state: 'warm-up', questions });
    for (let i = 0; i < runs; i++) {
      const t = performance.now();
      await client.systemOne({ state: 'Customer asks why their transfer to a new payee is on hold.', questions });
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    return { p50: Math.round(samples[Math.floor(runs / 2)]!), p95: Math.round(samples[Math.ceil(runs * 0.95) - 1]!) };
  };
  const one = await time({ hold: noul('Is the transfer on hold for a fraud check?') }, 12);
  const three = await time(
    {
      hold: noul('Is the transfer on hold for a fraud check?'),
      route: choice('Which team?', { fraud: null, payments: null, support: null }),
      urgency: score('How urgent?', ['low', 'medium', 'high']),
    },
    12,
  );
  const health = (await (await fetch(`${proxy.url}/health`)).json()) as { rss_bytes: number };
  console.log(
    `PASS  measured on ${os.cpus()[0]?.model.trim()} (${os.cpus().length} threads, ${os.arch()}): ` +
      `load ${loadMs} ms, 1 question p50 ${one.p50} ms / p95 ${one.p95} ms, ` +
      `3 questions p50 ${three.p50} ms / p95 ${three.p95} ms, RSS ${Math.round(health.rss_bytes / 1e6)} MB`,
  );
} finally {
  await proxy.close();
}
