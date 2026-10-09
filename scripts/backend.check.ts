/**
 * Backend selection rules for the npm example entry points (scripts/backend.ts).
 * Pure: reads no environment beyond the objects passed in and starts no proxy.
 */
import assert from 'node:assert/strict';
import { applyBackend, chooseBackend, parseBackend } from './backend.ts';

let checks = 0;
const pass = (message: string) => {
  checks += 1;
  console.log(`PASS  ${message}`);
};

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => ({ ...vars });

assert.equal(chooseBackend(undefined, env({})).backend, 'local');
pass('with no credential, the example entry points use the local Laya proxy');

assert.equal(chooseBackend(undefined, env({ AI_GATEWAY_API_KEY: 'key' })).backend, 'gateway');
assert.equal(chooseBackend(undefined, env({ VERCEL_OIDC_TOKEN: 'token' })).backend, 'gateway');
pass('either Gateway credential selects Jev through Gateway');

assert.equal(chooseBackend(undefined, env({ AI_GATEWAY_API_KEY: '   ' })).backend, 'local');
pass('a blank credential is not a credential');

assert.equal(chooseBackend(undefined, env({ AI_GATEWAY_API_KEY: 'key', JEV_MOCK: '1' })).backend, 'mock');
pass('JEV_MOCK=1 selects fixtures even when a credential is set');

assert.equal(chooseBackend(undefined, env({ AI_GATEWAY_API_KEY: 'key', JEV_BACKEND: 'local' })).backend, 'local');
assert.equal(chooseBackend(undefined, env({ JEV_BACKEND: 'gateway' })).backend, 'gateway');
pass('an explicit JEV_BACKEND wins over the credential check');

assert.equal(chooseBackend('mock', env({ AI_GATEWAY_API_KEY: 'key' })).backend, 'mock');
assert.equal(chooseBackend('local', env({ AI_GATEWAY_API_KEY: 'key' })).backend, 'local');
assert.equal(chooseBackend('gateway', env({})).backend, 'gateway');
pass('--backend wins over everything else, including a missing credential');

assert.equal(parseBackend('local'), 'local');
assert.throws(() => parseBackend('openrouter'), /--backend must be gateway, local or mock/);
pass('--backend accepts only gateway, local or mock');

const target = env({});
applyBackend(target, 'local');
assert.equal(target['JEV_BACKEND'], 'local');
assert.equal(target['JEV_MOCK'], '0');
applyBackend(target, 'mock');
assert.equal(target['JEV_MOCK'], '1');
pass('applyBackend writes the choice where the examples read it');

console.log(`\n${checks}/${checks} checks passed.`);
