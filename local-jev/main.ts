/**
 * Starts the local Jev-compatible proxy: `node local-jev/main.ts`.
 *
 *   LOCAL_JEV_HOST        bind address (default 127.0.0.1)
 *   LOCAL_JEV_PORT        port (default 8765; 0 picks a free one)
 *   LOCAL_JEV_MODEL_DIR   use an exported Laya ONNX bundle instead of downloading
 *   LOCAL_JEV_REVISION    receptron/laya-onnx revision (default: pinned commit)
 *   LOCAL_JEV_THREADS     ONNX Runtime intra-op threads (default: runtime choice)
 *   LOCAL_JEV_OVERFLOW    extend (default) | reject | truncate — input longer than
 *                         Laya's trained 512/192 tokens; see OverflowPolicy in app.ts
 *
 * The first start downloads the 1.7 GB fp32 bundle to ~/.cache/receptron-laya.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createLocalJevServer, type OverflowPolicy } from './app.ts';
import { loadLayaEngine } from './engine.ts';

export interface RunningLocalJev {
  url: string;
  model: string;
  overflow: OverflowPolicy;
  server: Server;
  close(): Promise<void>;
}

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export async function startLocalJev(overrides: { port?: number; log?: (line: string) => void } = {}): Promise<RunningLocalJev> {
  if (env('LOCAL_JEV_TRUNCATION')) throw new Error('LOCAL_JEV_TRUNCATION was replaced by LOCAL_JEV_OVERFLOW=extend|reject|truncate.');
  const overflow = (env('LOCAL_JEV_OVERFLOW') ?? 'extend') as OverflowPolicy;
  if (!['extend', 'reject', 'truncate'].includes(overflow)) throw new Error('LOCAL_JEV_OVERFLOW must be extend, reject or truncate.');
  const threads = env('LOCAL_JEV_THREADS');
  const modelDir = env('LOCAL_JEV_MODEL_DIR');
  const revision = env('LOCAL_JEV_REVISION');

  let reported = -10;
  const engine = await loadLayaEngine({
    ...(modelDir ? { modelDir } : {}),
    ...(revision ? { revision } : {}),
    ...(threads ? { threads: Number(threads) } : {}),
    onProgress: ({ file, received, total }) => {
      if (!total) return;
      const pct = Math.floor((100 * received) / total);
      if (pct >= reported + 10) {
        reported = pct;
        console.error(`downloading ${file} ${pct}%`);
      }
    },
  });

  const server = createLocalJevServer(engine, { overflow, ...(overrides.log ? { log: overrides.log } : {}) });
  const host = env('LOCAL_JEV_HOST') ?? '127.0.0.1';
  const port = overrides.port ?? Number(env('LOCAL_JEV_PORT') ?? 8765);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}`,
    model: engine.model,
    overflow,
    server,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await engine.close();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const running = await startLocalJev({ log: (line) => console.log(line) });
  console.log(`local Jev-compatible proxy ready at ${running.url} — model ${running.model} (Laya, NOT Jev)`);
  console.log(`over-length input: ${running.overflow} (LOCAL_JEV_OVERFLOW)`);
  console.log(`use it from the examples with JEV_BACKEND=local LOCAL_JEV_URL=${running.url}`);
  const stop = () => void running.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
