/**
 * Contract checks for the local proxy, driven through the real
 * `@typesafe-ai/sdk` client. A scripted engine stands in for Laya, so this runs
 * in CI without model weights; `npm run local-jev:parity` repeats the wire
 * checks against the real model.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { choice, noul, score, TypeSafeClient, UnprocessableEntityError } from '@typesafe-ai/sdk';
import type { EntryType } from '@typesafe-ai/sdk';
import { createLocalJevServer, type ContextLimits, type DecisionEngine, type FidelityIssue, type OverflowPolicy } from './app.ts';
import type { LayaAnswer, LayaQuestion, LayaResult } from './protocol.ts';

const seen: { state: EntryType; questions: Record<string, LayaQuestion> }[] = [];
let issues: FidelityIssue[] = [];
let needed: ContextLimits = { maxLen: 512, headMaxLen: 192 };
const contexts: (ContextLimits | undefined)[] = [];
let failWith: string | undefined;
let wrongLabels = false;

function uniform(keys: string[]): Record<string, number> {
  return Object.fromEntries(keys.map((key) => [key, Math.round(1e4 / keys.length) / 1e4]));
}

const engine: DecisionEngine = {
  model: 'local-laya/test-engine',
  description: 'scripted engine for contract checks',
  releaseDate: '2026-09-19',
  trained: { maxLen: 512, headMaxLen: 192 },
  maxPositions: 8192,
  inspect: () => ({ issues, needed }),
  async systemOne(state, questions, context): Promise<LayaResult> {
    seen.push({ state, questions });
    contexts.push(context);
    if (failWith) throw new Error(failWith);
    const answers: Record<string, LayaAnswer & { rl_agent?: unknown }> = {};
    for (const [name, q] of Object.entries(questions)) {
      if (q.type === 'choice') {
        const labels = wrongLabels ? ['unexpected'] : Object.keys(q.criteria);
        answers[name] = { type: 'choice', choice: labels[0]!, probabilities: uniform(labels), confidence: 0, rl_agent: { act_probability: 1 } };
      } else if (q.type === 'score') {
        const levels = q.criteria.map((_, i) => String(i));
        answers[name] = {
          type: 'score',
          score: (levels.length - 1) / 2,
          legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])),
          probabilities: uniform(levels),
          confidence: 0,
          rl_agent: { act_probability: 1 },
        };
      } else {
        answers[name] = { type: 'noul', noul: 0.25, rl_agent: { act_probability: 1 } };
      }
    }
    return { answers, usage: { input_tokens: 42, output_tokens: 0 } };
  },
};

const server = createLocalJevServer(engine);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const client = new TypeSafeClient({ apiKey: 'local', baseURL: base, defaultModel: 'typesafe-ai/jev', retry: { maxRetries: 0 } });

try {
  const result = await client.systemOne({
    state: { ticket: 'refund missing', amount: 12.5 },
    questions: {
      route: choice('Which team?', { billing: 'payments', support: null, fraud: { signals: ['chargeback'] } }),
      urgency: score('How urgent?', ['low', null, { level: 'high' }]),
      mapped: score('Mapped rubric', { 0: 'no', 1: 'yes' }),
      churn: noul('Will they churn?'),
      dispute: noul(null, { true: 'they dispute', false: null }),
    },
  });

  assert.equal(result.model, 'local-laya/test-engine');
  assert.deepEqual(result.usage, { input_tokens: 42, output_tokens: 0 });
  assert.deepEqual(Object.keys(result.answers.route).sort(), ['choice', 'confidence', 'probabilities', 'type']);
  assert.deepEqual(Object.keys(result.answers.route.probabilities), ['billing', 'support', 'fraud']);
  assert.deepEqual(Object.keys(result.answers.urgency).sort(), ['confidence', 'legend', 'probabilities', 'score', 'type']);
  assert.deepEqual(result.answers.urgency.legend, { 0: 'low', 1: null, 2: { level: 'high' } });
  assert.deepEqual(result.answers.mapped.legend, { 0: 'no', 1: 'yes' });
  assert.deepEqual(Object.keys(result.answers.churn).sort(), ['noul', 'type']);
  console.log('PASS  SDK round-trip returns exact TypeSafe answer shapes; Laya-only fields are stripped');

  const sent = seen[0]!;
  assert.deepEqual(sent.state, { ticket: 'refund missing', amount: 12.5 });
  assert.deepEqual(sent.questions['route'], {
    type: 'choice',
    instructions: 'Which team?',
    criteria: { billing: 'payments', support: null, fraud: '{"signals":["chargeback"]}' },
  });
  assert.deepEqual(sent.questions['urgency'], { type: 'score', instructions: 'How urgent?', criteria: ['low', '', '{"level":"high"}'] });
  assert.deepEqual(sent.questions['mapped'], { type: 'score', instructions: 'Mapped rubric', criteria: ['no', 'yes'] });
  assert.deepEqual(sent.questions['churn'], { type: 'noul', instructions: 'Will they churn?' });
  assert.deepEqual(sent.questions['dispute'], { type: 'noul', instructions: '', criteria: { true: 'they dispute' } });
  console.log('PASS  structured, null and score-map entries are translated for Laya without losing labels');

  const models = await client.models.list();
  assert.equal(models[0]?.name, 'local-laya/test-engine');
  const health = await (await fetch(`${base}/health`)).json() as { jev: boolean; model: string };
  assert.equal(health.jev, false);
  console.log('PASS  /v1/models and /health name the local model and never claim Jev');

  const withPolicy = async (overflow: OverflowPolicy) => {
    const policyServer = createLocalJevServer(engine, { overflow });
    policyServer.listen(0, '127.0.0.1');
    await once(policyServer, 'listening');
    const response = await fetch(`http://127.0.0.1:${(policyServer.address() as AddressInfo).port}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'x', questions: { route: { type: 'choice', criteria: { a: null, b: null } } } }),
    });
    policyServer.close();
    return { status: response.status, overflow: response.headers.get('x-local-jev-overflow'), context: contexts.at(-1) };
  };
  const stateCut: FidelityIssue = { question: 'route', kind: 'state_truncated', detail: 'state is 900 tokens; the 512-token context keeps 316' };
  issues = [stateCut];
  needed = { maxLen: 1100, headMaxLen: 192 };
  const extended = await client.systemOne({ state: 'x', questions: { route: choice('Which?', { a: null, b: null }) } }).asResponse();
  assert.equal(extended.headers.get('x-local-jev-overflow'), 'extended');
  assert.equal(extended.headers.get('x-local-jev-context'), '1100/192');
  assert.deepEqual(contexts.at(-1), { maxLen: 1100, headMaxLen: 192 });
  assert.deepEqual(await withPolicy('reject'), { status: 422, overflow: null, context: { maxLen: 1100, headMaxLen: 192 } });
  assert.deepEqual(await withPolicy('truncate'), { status: 200, overflow: 'truncated', context: { maxLen: 512, headMaxLen: 192 } });

  issues = [stateCut, { question: 'route', kind: 'option_capped', detail: "1 option(s) exceed the package's fixed 48-token per-option cap" }];
  await assert.rejects(
    () => client.systemOne({ state: 'x', questions: { route: choice('Which?', { a: null, b: null }) } }),
    (error: unknown) => error instanceof UnprocessableEntityError && /silently drop input: route \(1 option/.test(error.message) && !/900 tokens/.test(error.message),
  );
  issues = [stateCut];
  needed = { maxLen: 9000, headMaxLen: 192 };
  await assert.rejects(
    () => client.systemOne({ state: 'x', questions: { route: choice('Which?', { a: null, b: null }) } }),
    (error: unknown) => error instanceof UnprocessableEntityError && /needs 9000 tokens, over the encoder's 8192/.test(error.message),
  );
  issues = [];
  needed = { maxLen: 512, headMaxLen: 192 };
  const plain = await client.systemOne({ state: 'x', questions: { route: choice('Which?', { a: null, b: null }) } }).asResponse();
  assert.equal(plain.headers.get('x-local-jev-overflow'), 'none');
  assert.deepEqual(contexts.at(-1), { maxLen: 512, headMaxLen: 192 });
  console.log('PASS  over-length input runs at an extended context by default; reject, truncate and hard limits behave as documented');

  failWith = 'question "route": options do not fit in head_max_len=192 tokens';
  await assert.rejects(
    () => client.systemOne({ state: 'x', questions: { route: choice('Which?', { a: null, b: null }) } }),
    (error: unknown) => error instanceof UnprocessableEntityError && /head_max_len/.test(error.message),
  );
  failWith = undefined;
  wrongLabels = true;
  const mismatch = await client
    .systemOne({ state: 'x', questions: { route: choice('Which?', { a: null, b: null }) } })
    .asResponse()
    .catch((error: { status?: number }) => error);
  assert.equal((mismatch as { status?: number }).status, 502);
  wrongLabels = false;
  console.log('PASS  backend limits surface as SDK errors; label drift is a 502, not a wrong answer');

  const post = (body: string) =>
    fetch(`${base}/v1/systemone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const cases: [string, number, RegExp][] = [
    ['{', 400, /not valid JSON/],
    [JSON.stringify({ questions: { a: { type: 'noul' } } }), 400, /state: is required/],
    [JSON.stringify({ state: null, questions: {} }), 400, /nonempty object/],
    [JSON.stringify({ state: null, questions: { a: { type: 'rank', criteria: [] } } }), 400, /must be "choice"/],
    [JSON.stringify({ state: null, questions: { a: { type: 'score', criteria: {} } } }), 400, /nonempty array/],
    [JSON.stringify({ state: null, questions: { a: { type: 'noul', criteria: { maybe: 'x' } } } }), 400, /true\/false/],
  ];
  for (const [body, status, message] of cases) {
    const response = await post(body);
    assert.equal(response.status, status, body);
    assert.match(((await response.json()) as { error: { message: string } }).error.message, message);
  }
  assert.equal((await fetch(`${base}/v1/nope`)).status, 404);
  assert.equal((await fetch(`${base}/v1/systemone`)).status, 405);
  console.log('PASS  malformed requests get TypeSafe-style error bodies the SDK can read');
} finally {
  server.close();
  server.closeAllConnections();
}
