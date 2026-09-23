/**
 * Transport integration regressions. Uses loopback HTTP, never the Jev service;
 * these checks prove requests/mode boundaries, not model quality.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { choice } from '@typesafe-ai/sdk';
import { createClient } from '../../../src/client.ts';
import { mockFetch } from '../../../src/mock-fetch.ts';
import type { MockRequest, ScriptedAnswer } from '../../../src/mock-fetch.ts';
import { routingClient } from '../08-runbook-routing/transport.ts';
import { INCIDENTS } from '../08-runbook-routing/fixtures.ts';
import { resolveDeterministically } from '../08-runbook-routing/deterministic.ts';
import { collect } from './collect.ts';
import { measurePerturbations } from './perturb.ts';

const execute = promisify(execFile);
const keys = [
  'JEV_MOCK', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN',
  'AI_GATEWAY_TYPESAFE_BASE_URL', 'AI_GATEWAY_GENERATIVE',
  'TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'TYPESAFE_DEFAULT_MODEL',
] as const;

export async function checkIntegration(): Promise<void> {
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const requests: MockRequest[] = [];
  const paths: string[] = [];
  let responseStatus = 200;
  const wire = mockFetch((request) => {
    requests.push(request);
    return Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
      let answer: ScriptedAnswer;
      if (question.type === 'choice') {
        const ids = Object.keys(question.criteria);
        // Intentionally unlike the fixtures: 08 always abstains; 07 chooses
        // the first eligible action/record. Live drivers must tolerate both.
        answer = { choice: name === 'first_remediation' ? 'none-of-these' : ids[0]!, strength: 0.99 };
      } else {
        answer = { noul: 0.99 };
      }
      return [name, answer];
    }));
  });
  const server = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      paths.push(request.url ?? '');
      if (responseStatus !== 200) {
        response.writeHead(responseStatus, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Loopback credential rejected' } }));
        return;
      }
      const result = await wire(`http://localhost${request.url}`, { body });
      const payload = await result.json() as Record<string, unknown>;
      payload.model = 'loopback-regression-model';
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const directory = mkdtempSync(join(process.cwd(), '.jev-integration-'));

  try {
    process.env['JEV_MOCK'] = '0';
    process.env['AI_GATEWAY_API_KEY'] = 'loopback-only-not-a-real-key';
    process.env['VERCEL_OIDC_TOKEN'] = '';
    process.env['AI_GATEWAY_GENERATIVE'] = '0';
    process.env['TYPESAFE_API_KEY'] = '';
    process.env['TYPESAFE_BASE_URL'] = `http://127.0.0.1:${address.port}/direct-must-not-be-used`;
    process.env['AI_GATEWAY_TYPESAFE_BASE_URL'] = `http://127.0.0.1:${address.port}/typesafe`;
    process.env['TYPESAFE_DEFAULT_MODEL'] = 'typesafe-ai/jev';
    const request = { state: { synthetic: true }, questions: { selection: choice('Pick one', { a: 'A', b: 'B', c: 'C' }) } };

    for (const fault of ['timeout', 'malformed'] as const) {
      const routing = routingClient(() => { throw new Error('Live path read a fixture script'); }, fault);
      assert.equal(routing.live, true);
      const result = await routing.client.systemOne(request);
      assert.equal(result.model, 'loopback-regression-model');
    }
    assert.equal(requests.length, 2, 'fault-labelled incidents must still call the live transport');
    assert(requests.every((request) => request.model === 'typesafe-ai/jev'));
    assert(paths.every((path) => path === '/typesafe/v1/systemone'));

    const beforePerturb = requests.length;
    const measured = await measurePerturbations(
      createClient().client,
      { case: 'synthetic' },
      { a: 'Action A', b: 'Action B', c: 'Action C', none_of_these: 'No action' },
    );
    assert.equal(requests.length - beforePerturb, 4);
    assert.equal(measured.length, 4);
    const [baseline, added, removed, reordered] = measured;
    assert(baseline && added && removed && reordered);
    assert.equal(added.optionIds.length, baseline.optionIds.length + 1);
    assert.equal(removed.optionIds.length, baseline.optionIds.length - 1);
    assert(removed.optionIds.includes(baseline.choice));
    assert(removed.optionIds.includes('none_of_these'));
    const lowestUnselected = baseline.optionIds
      .filter((id) => id !== baseline.choice && id !== 'none_of_these')
      .sort((a, b) => baseline.probabilities[a]! - baseline.probabilities[b]!)[0];
    assert(lowestUnselected && !removed.optionIds.includes(lowestUnselected));
    assert.deepEqual(reordered.optionIds, [...baseline.optionIds].reverse());
    assert(measured.every((row) => row.model === 'loopback-regression-model'));
    assert(requests.slice(beforePerturb).every((entry) => JSON.stringify(entry.state) === '{"case":"synthetic"}'));
    assert.equal(Object.keys(added.deltasFromBaseline).length, baseline.optionIds.length);

    const beforeCli: number = requests.length;
    const liveCli = await execute(process.execPath, [join('examples', 'fsi', 'eval', 'perturb.ts')], {
      env: process.env,
      timeout: 30_000,
    });
    assert.equal(requests.length - beforeCli, 4, 'live instrument entrypoint must make four requests');
    const lines = liveCli.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 5);
    assert.equal(lines[0].mode, 'LIVE_API');
    assert(lines.slice(1).every((line) => line.model === 'loopback-regression-model'));

    for (const id of ['07-next-step', '08-runbook-routing']) {
      const before: number = requests.length;
      const ledger = join(directory, `${id}.jsonl`);
      await execute(process.execPath, [join('examples', 'fsi', id, 'index.ts')], {
        env: { ...process.env, JEV_LEDGER_FILE: ledger },
        timeout: 30_000,
        maxBuffer: 2_000_000,
      });
      assert(requests.length > before, `${id} did not send any requests`);
      const records = readFileSync(ledger, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert(records.every((record) => record.mode === 'LIVE_API'));
      assert(records.some((record) => record.service.model === 'loopback-regression-model'));
      if (id === '08-runbook-routing') {
        const residual = INCIDENTS.filter((incident) => !resolveDeterministically(incident).resolved);
        assert.equal(requests.length - before, residual.length, 'one real request per abstaining residual, including fault fixtures');
      } else {
        assert(requests.slice(before).some((entry) =>
          entry.questions.selection?.type === 'choice' &&
          Object.keys(entry.questions.selection.criteria).some((option) => option.startsWith('TXN-')),
        ), 'record selection must also reach the SDK transport');
      }
    }

    responseStatus = 401;
    for (const id of ['07-next-step', '08-runbook-routing']) {
      await assert.rejects(
        execute(process.execPath, [join('examples', 'fsi', id, 'index.ts')], {
          env: { ...process.env, JEV_LEDGER_FILE: join(directory, `${id}-failure.jsonl`) },
          timeout: 30_000,
          maxBuffer: 2_000_000,
        }),
        (error: unknown) => {
          const failure = error as Error & { code?: number; stderr?: string };
          assert.equal(failure.code, 1, `${id} must fail visibly rather than exit successfully`);
          assert.match(failure.stderr ?? '', /live Jev request failed/);
          return true;
        },
      );
    }
    responseStatus = 200;

    const beforeSweep = requests.length;
    const workspacesBefore = readdirSync(process.cwd()).filter((name) => name.startsWith('.jev-eval-'));
    const runs = collect();
    assert(runs.every((run) => run.records.length > 0 && run.records.every((record) => record.mode === 'SCRIPTED_MOCK')));
    assert.equal(requests.length, beforeSweep, 'fixture sweep must never use inherited live credentials');
    assert.deepEqual(readdirSync(process.cwd()).filter((name) => name.startsWith('.jev-eval-')), workspacesBefore);

    process.env['JEV_MOCK'] = '1';
    const malformed = routingClient(() => ({}), 'malformed');
    assert.equal(malformed.live, false);
    const bad = await malformed.client.systemOne(request);
    assert.equal(bad.answers.selection, undefined);
    await assert.rejects(measurePerturbations(malformed.client, {}, { a: 'A', b: 'B', c: 'C' }), /Unusable distribution/);
    await assert.rejects(routingClient(() => ({}), 'timeout').client.systemOne(request));
    const mockCli = await execute(process.execPath, [join('examples', 'fsi', 'eval', 'perturb.ts')], {
      env: process.env,
    }).then(() => null, (error: Error) => error);
    assert(mockCli, 'live instrument must reject explicit offline mode');
    assert.match(mockCli.message, /requires live Jev/);

    process.env['JEV_MOCK'] = '0';
    delete process.env['AI_GATEWAY_API_KEY'];
    delete process.env['VERCEL_OIDC_TOKEN'];
    process.env['TYPESAFE_API_KEY'] = 'direct-key-must-not-enable-live';
    assert.throws(() => routingClient(() => ({}), 'malformed'), /AI_GATEWAY_API_KEY/);
    assert(paths.every((path) => path === '/typesafe/v1/systemone'));
    console.log('PASS  FSI integration: live SDK requests, offline fault isolation, four perturbations, offline sweep');
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(directory, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

if (import.meta.filename === process.argv[1]) {
  await checkIntegration();
}
