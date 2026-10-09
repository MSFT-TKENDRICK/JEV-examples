/**
 * Runs one example on a backend that is named on the command line. Nothing
 * falls back silently: a live run without a key fails, and a local run says it
 * is Laya.
 *
 *   node scripts/run-example.ts examples/01-quickstart.ts --backend=local
 *   node scripts/run-example.ts examples/python/judge_rubric.py --backend=local
 *   node scripts/run-example.ts examples/05-browser-live.ts --backend=gateway --no-video
 *
 *   --backend=gateway  live Jev through Vercel AI Gateway (default). Needs
 *                      AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN.
 *   --backend=local    the local Laya proxy in local-jev/. Not Jev. The launcher
 *                      starts it unless one already answers at LOCAL_JEV_URL.
 *   --backend=mock     scripted fixtures; no inference.
 *
 * Other arguments go to the example. Python examples (.py) run with
 * JEV_PYTHON, or `python` on Windows and `python3` elsewhere.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DEFAULT_LOCAL_URL = 'http://127.0.0.1:8765';
const READY_TIMEOUT_MS = 30 * 60_000;

type Backend = 'gateway' | 'local' | 'mock';

function fail(message: string): never {
  console.error(`run-example: ${message}`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): { example: string; backend: Backend; passthrough: string[] } {
  let backend: Backend = 'gateway';
  let example: string | undefined;
  const passthrough: string[] = [];
  for (const arg of argv) {
    const choice = /^--backend=(.+)$/.exec(arg)?.[1];
    if (choice !== undefined) {
      if (choice !== 'gateway' && choice !== 'local' && choice !== 'mock') {
        fail(`--backend must be gateway, local or mock, not "${choice}".`);
      }
      backend = choice;
    } else if (example === undefined && !arg.startsWith('--')) {
      example = arg;
    } else {
      passthrough.push(arg);
    }
  }
  if (example === undefined) fail('usage: node scripts/run-example.ts <example> [--backend=gateway|local|mock] [example args]');
  return { example, backend, passthrough };
}

/** Whether a Laya proxy answers at `url`. Any other server on that port does not count. */
async function isLayaProxy(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    const body = (await response.json()) as { backend?: unknown; jev?: unknown };
    return body.backend === 'laya' && body.jev === false;
  } catch {
    return false;
  }
}

async function waitForProxy(url: string, child: ChildProcess): Promise<void> {
  const started = Date.now();
  let exited: number | null | undefined;
  child.once('exit', (code) => (exited = code ?? 1));
  while (Date.now() - started < READY_TIMEOUT_MS) {
    if (await isLayaProxy(url)) return;
    if (exited !== undefined) fail(`the local Laya proxy exited with code ${exited} before it was ready. Run npm run local-jev:install if its dependencies are missing.`);
    await new Promise((done) => setTimeout(done, 1_000));
  }
  fail(`the local Laya proxy was not ready at ${url} after 30 minutes.`);
}

function startLocalProxy(url: string): ChildProcess {
  const parsed = new URL(url);
  const entry = join(ROOT, 'local-jev', 'main.ts');
  if (!existsSync(entry)) fail(`${relative(ROOT, entry)} is missing.`);
  console.error(`run-example: starting the local Laya proxy at ${url} (not Jev). The first start downloads the model.`);
  return spawn(process.execPath, [entry], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      LOCAL_JEV_HOST: parsed.hostname,
      LOCAL_JEV_PORT: parsed.port || '8765',
    },
  });
}

function exampleCommand(file: string, passthrough: readonly string[]): { command: string; args: string[] } {
  if (file.endsWith('.py')) {
    const fallback = process.platform === 'win32' ? 'python' : 'python3';
    return { command: process.env['JEV_PYTHON']?.trim() || fallback, args: ['-B', file, ...passthrough] };
  }
  return { command: process.execPath, args: [file, ...passthrough] };
}

async function main(): Promise<void> {
  const { example, backend, passthrough } = parseArgs(process.argv.slice(2));
  const file = resolve(ROOT, example);
  const inside = relative(ROOT, file);
  if (inside.startsWith('..') || inside.startsWith(sep) || !existsSync(file)) {
    fail(`${example} is not an example file inside this repository.`);
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (backend === 'mock') {
    env['JEV_MOCK'] = '1';
    env['JEV_BACKEND'] = 'gateway';
  } else {
    env['JEV_MOCK'] = '0';
    env['JEV_BACKEND'] = backend;
  }

  let proxy: ChildProcess | undefined;
  if (backend === 'local') {
    const url = env['LOCAL_JEV_URL']?.trim() || DEFAULT_LOCAL_URL;
    env['LOCAL_JEV_URL'] = url;
    if (!(await isLayaProxy(url))) {
      proxy = startLocalProxy(url);
      const owned = proxy;
      process.once('exit', () => owned.kill());
      await waitForProxy(url, owned);
    }
  }

  const { command, args } = exampleCommand(file, passthrough);
  const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', env });

  const stop = (signal: NodeJS.Signals) => {
    child.kill(signal);
    proxy?.kill(signal);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const code = await new Promise<number>((done) => {
    child.once('error', (error) => {
      console.error(`run-example: could not start ${command}: ${error.message}`);
      done(1);
    });
    child.once('exit', (exitCode, signal) => done(exitCode ?? (signal ? 1 : 0)));
  });
  proxy?.kill();
  process.exitCode = code;
}

await main();
