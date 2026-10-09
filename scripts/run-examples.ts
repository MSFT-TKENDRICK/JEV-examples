import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isLiveJev } from '../src/client.ts';
import { announce, applyBackend, chooseBackend, startLocalProxyIfNeeded } from './backend.ts';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--mock')) {
  throw new Error('Usage: node scripts/run-examples.ts [--mock]');
}
const choice = chooseBackend(args.includes('--mock') ? 'mock' : undefined, process.env);
applyBackend(process.env, choice.backend);
announce(choice);
isLiveJev();
const stopProxy = choice.backend === 'local' ? await startLocalProxyIfNeeded(process.env) : () => {};

const examples = [
  '../examples/01-quickstart.ts',
  '../examples/02-judge-rubrics.ts',
  '../examples/03-agent-harness.ts',
  '../examples/04-browser-use.ts',
  '../examples/06-jev-vs-control.ts',
  '../examples/fsi/07-next-step/index.ts',
  '../examples/fsi/08-runbook-routing/index.ts',
  '../examples/fsi/eval/index.ts',
];

try {
  for (const example of examples) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(example, import.meta.url))], {
      stdio: 'inherit',
      env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error(`Example ${example} failed (exit ${result.status}, signal ${result.signal}).`);
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  stopProxy();
}
