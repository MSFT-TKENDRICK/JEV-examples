/**
 * Runs one example, or a Python example, on the backend that scripts/backend.ts
 * chooses. Arguments after the example path go to the example.
 *
 *   node scripts/run-example.ts examples/01-quickstart.ts
 *   node scripts/run-example.ts examples/01-quickstart.ts --backend=local
 *   node scripts/run-example.ts examples/05-browser-live.ts --no-video
 *   node scripts/run-example.ts examples/python/judge_rubric.py
 *
 * Python examples run with JEV_PYTHON, or `python` on Windows and `python3`
 * elsewhere.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { announce, applyBackend, type Backend, chooseBackend, parseBackend, startLocalProxyIfNeeded } from './backend.ts';

const ROOT = join(import.meta.dirname, '..');

function parseArgs(argv: readonly string[]): { example: string; requested: Backend | undefined; passthrough: string[] } {
  let requested: Backend | undefined;
  let example: string | undefined;
  const passthrough: string[] = [];
  for (const arg of argv) {
    const named = /^--backend=(.+)$/.exec(arg)?.[1];
    if (named !== undefined) requested = parseBackend(named);
    else if (example === undefined && !arg.startsWith('--')) example = arg;
    else passthrough.push(arg);
  }
  if (example === undefined) {
    throw new Error('usage: node scripts/run-example.ts <example> [--backend=gateway|local|mock] [example args]');
  }
  return { example, requested, passthrough };
}

function exampleCommand(file: string, passthrough: readonly string[]): { command: string; args: string[] } {
  if (file.endsWith('.py')) {
    const fallback = process.platform === 'win32' ? 'python' : 'python3';
    return { command: process.env['JEV_PYTHON']?.trim() || fallback, args: ['-B', file, ...passthrough] };
  }
  return { command: process.execPath, args: [file, ...passthrough] };
}

async function main(): Promise<number> {
  const { example, requested, passthrough } = parseArgs(process.argv.slice(2));
  const file = resolve(ROOT, example);
  const inside = relative(ROOT, file);
  if (inside.startsWith('..') || inside.startsWith(sep) || !existsSync(file)) {
    throw new Error(`${example} is not an example file in this repository.`);
  }

  const choice = chooseBackend(requested, process.env);
  applyBackend(process.env, choice.backend);
  announce(choice);
  const stopProxy = choice.backend === 'local' ? await startLocalProxyIfNeeded(process.env) : () => {};
  try {
    const { command, args } = exampleCommand(file, passthrough);
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.once('SIGINT', forward);
    process.once('SIGTERM', forward);
    return await new Promise<number>((done) => {
      child.once('error', (error) => {
        console.error(`run: could not start ${command}: ${error.message}`);
        done(1);
      });
      child.once('exit', (code, signal) => done(code ?? (signal ? 1 : 0)));
    });
  } finally {
    stopProxy();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  },
);
