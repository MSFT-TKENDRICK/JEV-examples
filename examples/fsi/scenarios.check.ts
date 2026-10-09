/**
 * Runs every new FSI example against its scripted fixtures, in process, and checks
 * each scenario against the outcome it declares. Each example must also show a probe
 * that changes the answer, a budget refusal, and no banned route word in its source.
 */
process.env['JEV_MOCK'] = '1';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BANNED_ROUTE_WORDS, type Result } from '../../src/decision-loop.ts';
import { run as fraud } from './09-fraud-alerts/index.ts';
import { run as claims } from './10-insurance-claims/index.ts';
import { run as content } from './11-content-safety/index.ts';
import { run as audit } from './12-compliance-audit/index.ts';
import { run as signals } from './13-semantic-signals/index.ts';
import { run as search } from './14-search-rerank/index.ts';

const silent = () => {};
const ROOT = join(import.meta.dirname, '..', '..');

const EXAMPLES: { name: string; source: string; results: () => Promise<Result[]> }[] = [
  { name: '09 fraud alerts', source: 'examples/fsi/09-fraud-alerts/index.ts', results: async () => (await fraud(silent)).results },
  { name: '10 insurance claims', source: 'examples/fsi/10-insurance-claims/index.ts', results: () => claims(silent) },
  { name: '11 content safety', source: 'examples/fsi/11-content-safety/index.ts', results: () => content(silent) },
  { name: '12 compliance audit', source: 'examples/fsi/12-compliance-audit/index.ts', results: async () => (await audit(silent)).results },
  { name: '13 semantic signals', source: 'examples/fsi/13-semantic-signals/index.ts', results: () => signals(silent) },
  { name: '14 search rerank', source: 'examples/fsi/14-search-rerank/index.ts', results: () => search(silent) },
];

let checks = 0;
for (const example of EXAMPLES) {
  const results = await example.results();
  assert.ok(results.length > 0, `${example.name}: ran no decisions`);

  for (const result of results) {
    assert.equal(
      result.outcome,
      result.expect.outcome,
      `${result.id}: ended ${result.outcome} (${result.reason}), expected ${result.expect.outcome}`,
    );
    if (result.expect.flipped !== undefined) {
      assert.equal(result.flipped, result.expect.flipped, `${result.id}: flipped was ${result.flipped}`);
    }
    for (const word of BANNED_ROUTE_WORDS) {
      assert.ok(!result.leader.includes(word) && !result.outcome.includes(word), `${result.id}: names banned route "${word}"`);
    }
    checks += 1;
  }

  assert.ok(
    results.some((r) => r.flipped && r.probes.length > 0),
    `${example.name}: no run where a probe changed the answer`,
  );
  assert.ok(
    results.some((r) => r.outcome === 'refused' && /probe|budget|affordable/.test(r.reason)),
    `${example.name}: no run refused because the probe budget ran out`,
  );

  const source = readFileSync(join(ROOT, example.source), 'utf8');
  for (const word of BANNED_ROUTE_WORDS) {
    assert.ok(!new RegExp(`['"]${word}['"]`).test(source), `${example.name}: source names banned route "${word}"`);
  }
  console.log(`PASS  ${example.name}: ${results.length} decision(s) end where their scenarios say`);
}

console.log(`\n${checks}/${checks} decisions checked across ${EXAMPLES.length} examples.`);
