/**
 * Launching a Chrome that webreel's recorder can actually capture.
 *
 * This file exists because of a bug in webreel 0.1.4, not because the launcher
 * needed rewriting. `launchChrome({ headless: true })` starts the headless
 * shell with `--enable-begin-frame-control` and
 * `--run-all-compositor-stages-before-draw`. Those flags hand frame production
 * to the client: the compositor stops drawing on its own and only advances
 * when someone calls `HeadlessExperimental.beginFrame`.
 *
 * webreel's own `Recorder` never calls it — its capture loop calls
 * `Page.captureScreenshot`, which under those flags waits for a frame that will
 * never be produced and hangs forever. The recorder's loop then sits on the
 * first await, `frameCount` stays at 0, and `stop()` silently deletes the empty
 * temp file. You get a clean exit, no warning, and no video.
 *
 * So we start the same binary webreel downloaded, with the same flags minus the
 * two that break capture. Everything downstream — `connectCDP`, `Recorder`,
 * the cursor overlays, the ffmpeg pipeline — is still webreel's.
 *
 * If webreel fixes this, delete this file and call `launchChrome` directly.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { launchChrome, pause } from '@webreel/core';

const CACHE = resolve(homedir(), '.webreel', 'bin', 'chrome-headless-shell');

function cachedShell(): string | null {
  if (!existsSync(CACHE)) return null;
  const exe = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  for (const entry of readdirSync(CACHE, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const direct = resolve(CACHE, entry.name, exe);
    if (existsSync(direct)) return direct;
    const nested = resolve(CACHE, entry.name, 'bin', exe);
    if (existsSync(nested)) return nested;
  }
  return null;
}

/**
 * Let webreel do the one thing we do want from its launcher: fetch the browser.
 * We start it, immediately kill it, and keep the binary it left behind.
 */
async function ensureShellDownloaded(): Promise<string | null> {
  if (cachedShell()) return cachedShell();
  const warm = await launchChrome({ headless: true });
  warm.kill();
  await pause(300);
  return cachedShell();
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

export interface LaunchedChrome {
  port: number;
  kill: () => void;
}

export async function launchRecordableChrome(): Promise<LaunchedChrome> {
  const exe = await ensureShellDownloaded();

  // No cached binary and no download: fall back to webreel's launcher. The
  // agent loop will run; recording will produce nothing, and example 05
  // reports that rather than pretending otherwise.
  if (!exe) return launchChrome({ headless: true });

  const port = await freePort();
  const proc: ChildProcess = spawn(
    exe,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${resolve(tmpdir(), `jev-examples-${Date.now()}`)}`,
      '--no-sandbox',
      '--no-first-run',
      '--hide-scrollbars',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--mute-audio',
      'about:blank', // headless shell exposes no debuggable target without one
    ],
    { stdio: 'ignore' },
  );

  await pause(1500); // let the debugging port come up before connectCDP dials it
  return { port, kill: () => proc.kill() };
}
