/**
 * Chooses the backend for an example run, and keeps the local Laya proxy running
 * for as long as a run needs it.
 *
 * The first rule that matches decides, and the banner names the rule:
 *   1. --backend=... on the command line
 *   2. JEV_MOCK=1: scripted fixtures
 *   3. JEV_BACKEND=gateway or local, from the environment or .env
 *   4. a Gateway credential is set: Jev through Vercel AI Gateway
 *   5. no credential is set: the local Laya proxy, which is not Jev
 *
 * Rule 5 is the only fallback. It lets the examples run without a key. It is
 * never silent: the banner says the answers are Laya's. Direct `node examples/...`
 * runs do not use this file, so they still need a credential or JEV_BACKEND.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

export type Backend = 'gateway' | 'local' | 'mock';

export interface Choice {
  readonly backend: Backend;
  readonly reason: string;
}

const ROOT = join(import.meta.dirname, '..');
const DEFAULT_LOCAL_URL = 'http://127.0.0.1:8765';
const READY_TIMEOUT_MS = 30 * 60_000;

export function parseBackend(value: string): Backend {
  if (value === 'gateway' || value === 'local' || value === 'mock') return value;
  throw new Error(`--backend must be gateway, local or mock, not "${value}".`);
}

export function chooseBackend(requested: Backend | undefined, env: NodeJS.ProcessEnv): Choice {
  if (requested !== undefined) return { backend: requested, reason: 'named on the command line' };
  if (env['JEV_MOCK']?.trim() === '1') return { backend: 'mock', reason: 'JEV_MOCK=1' };
  const named = env['JEV_BACKEND']?.trim();
  if (named === 'gateway' || named === 'local') return { backend: named, reason: `JEV_BACKEND=${named}` };
  if (env['AI_GATEWAY_API_KEY']?.trim() || env['VERCEL_OIDC_TOKEN']?.trim()) {
    return { backend: 'gateway', reason: 'a Gateway credential is set' };
  }
  return { backend: 'local', reason: 'no Gateway credential is set; set AI_GATEWAY_API_KEY in .env to run Jev' };
}

/** Writes the choice into the environment the examples read. */
export function applyBackend(env: NodeJS.ProcessEnv, backend: Backend): void {
  env['JEV_MOCK'] = backend === 'mock' ? '1' : '0';
  env['JEV_BACKEND'] = backend === 'local' ? 'local' : 'gateway';
}

export function announce(choice: Choice): void {
  if (choice.backend === 'local') {
    console.error(`run: using the local Laya proxy, which is NOT Jev (${choice.reason}).`);
  } else {
    console.error(`run: backend ${choice.backend} (${choice.reason}).`);
  }
}

/** Whether a Laya proxy answers at `url`. Another server on that port does not count. */
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

/**
 * Makes sure a Laya proxy answers at LOCAL_JEV_URL and returns the function that
 * stops it. A proxy that is already running is reused and left running.
 */
export async function startLocalProxyIfNeeded(env: NodeJS.ProcessEnv): Promise<() => void> {
  const url = env['LOCAL_JEV_URL']?.trim() || DEFAULT_LOCAL_URL;
  env['LOCAL_JEV_URL'] = url;
  if (await isLayaProxy(url)) return () => {};

  const parsed = new URL(url);
  console.error(`run: starting the local Laya proxy at ${url}. The first start loads the model.`);
  let problem: string | undefined;
  const child: ChildProcess = spawn(process.execPath, [join(ROOT, 'local-jev', 'main.ts')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...env, LOCAL_JEV_HOST: parsed.hostname, LOCAL_JEV_PORT: parsed.port || '8765' },
  });
  child.once('error', (error) => (problem ??= error.message));
  child.once('exit', (code) => (problem ??= `exited with code ${code}`));
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };
  process.once('exit', stop);

  try {
    const started = Date.now();
    while (Date.now() - started < READY_TIMEOUT_MS) {
      if (await isLayaProxy(url)) return stop;
      if (problem !== undefined) {
        throw new Error(
          `the local Laya proxy stopped before it was ready (${problem}). ` +
            'If its dependencies are missing, run npm run local-jev:install.',
        );
      }
      await new Promise((done) => setTimeout(done, 1_000));
    }
    throw new Error(`the local Laya proxy was not ready at ${url} after 30 minutes.`);
  } catch (error) {
    stop();
    throw error;
  }
}
