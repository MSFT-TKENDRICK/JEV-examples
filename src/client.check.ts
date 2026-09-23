/**
 * Mode and HTTP transport checks. The loopback server tests SDK wiring, not
 * hosted Jev inference; no credentials or external network are required.
 */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { choice } from '@typesafe-ai/sdk';
import { activeBackend, backendLabel, createClient, isLiveGeneration, isLiveJev, JEV_GATEWAY_URL } from './client.ts';
import { fixtureTag, runMode } from './fixture-label.ts';
import { createControlJudge } from './control-agent.ts';
import { createTriager } from './tools/triage.ts';
import { createProposer } from './proposer.ts';
import { page, TASK } from './site/graph.ts';
import { createJevJudge } from './site/judges.ts';
import { describe } from './site/walk.ts';

const keys = [
  'TYPESAFE_API_KEY', 'JEV_MOCK', 'TYPESAFE_BASE_URL',
  'TYPESAFE_DEFAULT_MODEL', 'TYPESAFE_LOG_LEVEL',
  'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'AI_GATEWAY_TYPESAFE_BASE_URL',
  'AI_GATEWAY_GENERATIVE', 'JEV_BACKEND', 'LOCAL_JEV_URL',
] as const;
const saved = new Map(keys.map((key) => [key, process.env[key]]));
const requests: { method?: string; url?: string; authorization?: string; body: string }[] = [];
let status = 200;
let goalMet = 0.02;
const server = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk: string) => { body += chunk; });
  request.on('end', () => {
    requests.push({
      method: request.method, url: request.url,
      authorization: request.headers.authorization, body,
    });
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(status !== 200
      ? { error: { message: 'test service rejected credentials' } }
      : {
          model: 'typesafe-ai/jev',
          answers: {
            route: { type: 'choice', choice: 'technical', confidence: 0.8,
              probabilities: { billing: 0.1, technical: 0.9 } },
            target: { type: 'choice', choice: 'e5', confidence: 0.8,
              probabilities: { e1: 0.1, e2: 0, e3: 0, e4: 0, e5: 0.9, e6: 0, none: 0 } },
            goalMet: { type: 'noul', noul: goalMet },
            atTarget: { type: 'noul', noul: 0.04 },
            deadEnd: { type: 'noul', noul: 0.01 },
          },
          usage: { input_tokens: 10, output_tokens: 0 },
        }));
  });
});

try {
  for (const key of keys) delete process.env[key];
  assert.throws(() => createClient(), /AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is required/);
  process.env['AI_GATEWAY_API_KEY'] = '   ';
  assert.throws(() => createClient(), /AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is required/);
  delete process.env['AI_GATEWAY_API_KEY'];
  process.env['TYPESAFE_API_KEY'] = 'direct-service-key-must-not-be-used';
  assert.throws(() => createClient(), /AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is required/);
  process.env['JEV_MOCK'] = '0';
  assert.throws(() => createClient(), /AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is required/);
  process.env['JEV_MOCK'] = 'true';
  assert.throws(() => createClient(), /JEV_MOCK must be/);
  delete process.env['JEV_MOCK'];
  console.log('PASS  missing/blank credentials and invalid mode cannot silently select a mock');

  const entries = [
    '../examples/01-quickstart.ts', '../examples/02-judge-rubrics.ts',
    '../examples/03-agent-harness.ts', '../examples/04-browser-use.ts',
    '../examples/05-browser-live.ts', '../examples/06-jev-vs-control.ts',
    '../examples/fsi/07-next-step/index.ts', '../examples/fsi/08-runbook-routing/index.ts',
    '../scripts/run-examples.ts',
  ];
  for (const entry of entries) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(entry, import.meta.url))], {
      env: process.env, encoding: 'utf8', timeout: 20_000,
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, `${entry} should fail without a key`);
    assert.match(result.stderr, /AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is required/, entry);
  }
  console.log('PASS  every Jev example entrypoint requires credentials by default');

  const questions = {
    route: choice('Which team handles this?', { billing: 'Charges', technical: 'Bugs' }),
  };
  process.env['JEV_MOCK'] = '1';
  const offline = createClient(() => ({ route: { choice: 'billing' } }));
  assert.equal(offline.live, false);
  assert.equal((await offline.client.systemOne({ state: 'fixture', questions })).answers.route.choice, 'billing');
  console.log('PASS  explicit JEV_MOCK=1 runs offline without a key');

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  process.env['AI_GATEWAY_API_KEY'] = 'local-test-key';
  process.env['TYPESAFE_BASE_URL'] = 'https://direct-service.invalid';
  process.env['TYPESAFE_LOG_LEVEL'] = 'off';
  delete process.env['JEV_MOCK'];
  assert.equal(createClient().client.baseURL, JEV_GATEWAY_URL);
  assert.equal(createClient().client.defaultModel, 'typesafe-ai/jev');
  assert.equal(isLiveGeneration(), false);
  assert.equal(createControlJudge({ scripted: {} }).live, false);
  assert.equal(createTriager({ summary: 'fixture', suggestedRecordId: '' }).live, false);
  assert.equal(createProposer('fast', []).live, false);
  process.env['AI_GATEWAY_GENERATIVE'] = '1';
  assert.equal(isLiveGeneration(), true);
  assert.equal(createControlJudge({ scripted: {} }).live, true);
  process.env['AI_GATEWAY_GENERATIVE'] = '0';
  console.log('PASS  Gateway catalog model is default; legacy direct settings and paid models cannot take over');
  process.env['AI_GATEWAY_TYPESAFE_BASE_URL'] = `http://127.0.0.1:${address.port}/typesafe`;
  assert.equal(isLiveJev(), true);
  let scriptCalls = 0;
  const { client, live } = createClient(() => {
    scriptCalls++;
    throw new Error('Live mode must never evaluate an answer script');
  });
  assert.equal(live, true);
  const result = await client.systemOne({ state: { ticket: 'Broken integration' }, questions });
  assert.equal(result.answers.route.choice, 'technical');
  assert.deepEqual(result.answers.route.probabilities, { billing: 0.1, technical: 0.9 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, 'POST');
  assert.equal(requests[0]?.url, '/typesafe/v1/systemone');
  assert.equal(requests[0]?.authorization, 'Bearer local-test-key');
  const request = JSON.parse(requests[0]!.body);
  assert.equal(request.model, 'typesafe-ai/jev');
  assert.deepEqual(request.state, { ticket: 'Broken integration' });
  assert.deepEqual(request.questions.route.criteria, questions.route.criteria);
  assert.equal(scriptCalls, 0);
  console.log('PASS  default mode sends SDK HTTP requests and consumes service answers, never scripts');

  const judge = createJevJudge({ script: {
    home: { target: { choice: 'e1' }, goalMet: { noul: 1 } },
  } });
  assert.equal(judge.live, true);
  const history = ['Earlier page'];
  const judged = await judge.judge(page('home'), history);
  const browserRequest = JSON.parse(requests[1]!.body);
  assert.deepEqual(browserRequest.state, describe(page('home'), history));
  assert.equal(browserRequest.state.task, TASK);
  assert.notEqual(browserRequest.state.task, page('home').title);
  assert.equal(judged.prior['e5'], 0.9);
  assert.equal(judged.signals.goalMet, 0.02);
  console.log('PASS  browser judge sends the user task, page and history and uses service decisions');

  status = 401;
  await assert.rejects(() => client.systemOne({ state: 'auth failure', questions }));
  assert.equal(scriptCalls, 0);
  assert.equal(requests.length, 3);
  console.log('PASS  API failure propagates without falling back to scripted decisions');

  process.env['JEV_MOCK'] = '1';
  const forced = createClient(() => ({ route: { choice: 'billing' } }));
  assert.equal(forced.live, false);
  assert.equal((await forced.client.systemOne({ state: 'fixture', questions })).answers.route.choice, 'billing');
  assert.equal(requests.length, 3);
  console.log('PASS  explicit mock mode never sends a request even when credentials are set');

  status = 200;
  goalMet = 0.99;
  delete process.env['JEV_MOCK'];
  const comparison = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('../examples/06-jev-vs-control.ts', import.meta.url))],
    {
      env: { ...process.env, AI_GATEWAY_GENERATIVE: '0', CONTROL_THINK_MS: '0', NO_COLOR: '1' },
      timeout: 20_000,
    },
  );
  assert.equal(requests.length, 4);
  assert.match(comparison.stdout, /H\(Jev home response\) = 0\.3251 nats/);
  assert.match(comparison.stdout, /First clicks: Jev "\(none\)"/);
  assert.match(comparison.stdout, /The Jev arm used live Vercel AI Gateway responses/);
  assert.match(comparison.stdout, /control transport: SCRIPTED replay/);
  assert.doesNotMatch(comparison.stdout, /Both arms clicked/);
  console.log('PASS  comparison reports the service distribution and observed path, not a scripted outcome');

  delete process.env['AI_GATEWAY_API_KEY'];
  process.env['VERCEL_OIDC_TOKEN'] = 'loopback-oidc-token';
  const oidc = createClient();
  assert.equal(oidc.live, true);
  await oidc.client.systemOne({ state: 'OIDC auth', questions });
  assert.equal(requests[4]?.authorization, `Bearer ${process.env['VERCEL_OIDC_TOKEN']}`);
  assert.equal(requests[4]?.url, '/typesafe/v1/systemone');
  assert.equal(JSON.parse(requests[4]!.body).model, 'typesafe-ai/jev');
  console.log('PASS  Gateway OIDC authentication works without either API key');

  delete process.env['VERCEL_OIDC_TOKEN'];
  process.env['JEV_BACKEND'] = 'local';
  process.env['LOCAL_JEV_URL'] = `http://127.0.0.1:${address.port}/local`;
  const local = createClient();
  assert.equal(local.live, true);
  assert.equal(local.client.baseURL, process.env['LOCAL_JEV_URL']);
  await local.client.systemOne({ state: 'local proxy', questions });
  assert.equal(requests[5]?.url, '/local/v1/systemone');
  assert.equal(activeBackend(), 'local');
  assert.match(backendLabel(), /local Laya proxy .*not Jev/);
  assert.equal(runMode(true), 'LOCAL_MODEL');
  assert.match(fixtureTag(true), /^LOCAL_MODEL/);
  process.env['JEV_BACKEND'] = 'jev-but-local';
  assert.throws(() => createClient(), /JEV_BACKEND must be gateway/);
  process.env['JEV_BACKEND'] = 'local';
  process.env['JEV_MOCK'] = '1';
  assert.equal(createClient().live, false);
  assert.equal(runMode(false), 'SCRIPTED_MOCK');
  delete process.env['JEV_MOCK'];
  process.env['JEV_BACKEND'] = 'gateway';
  assert.throws(() => createClient(), /AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is required/);
  assert.equal(backendLabel(), 'Jev via Vercel AI Gateway');
  console.log('PASS  JEV_BACKEND=local needs no Gateway key, targets LOCAL_JEV_URL and is labelled not-Jev');
} finally {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
