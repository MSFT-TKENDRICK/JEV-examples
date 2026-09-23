/**
 * Uses the TypeSafe SDK through Vercel AI Gateway's compatible API.
 *
 * Jev is listed as free in Vercel's catalog. Gateway authentication is still
 * required; no direct TypeSafe account/key is needed. `JEV_BACKEND=local`
 * points the same SDK at the local Laya proxy in `local-jev/` — real model
 * inference with Jev's wire format, but not Jev, and labelled as such. Only
 * explicit `JEV_MOCK=1` swaps the transport for scripted offline fixtures.
 */

import { TypeSafeClient } from '@typesafe-ai/sdk';
import type { MockScript } from './mock-fetch.ts';
import { mockFetch } from './mock-fetch.ts';

export const JEV_GATEWAY_URL = 'https://ai-gateway.vercel.sh/typesafe';
export const JEV_GATEWAY_MODEL = 'typesafe-ai/jev';
export const LOCAL_JEV_URL = 'http://127.0.0.1:8765';

export type JevBackend = 'gateway' | 'local' | 'mock';

function gatewayCredential(): string | undefined {
  return process.env['AI_GATEWAY_API_KEY']?.trim() || process.env['VERCEL_OIDC_TOKEN']?.trim();
}

export function localJevUrl(): string {
  return process.env['LOCAL_JEV_URL']?.trim() || LOCAL_JEV_URL;
}

export interface ExampleClient {
  client: TypeSafeClient;
  /** True when calls perform real model inference (Gateway Jev or the local proxy). */
  live: boolean;
}

/** The configured backend, without requiring credentials. For labels only. */
export function activeBackend(): JevBackend {
  if (process.env['JEV_MOCK'] === '1') return 'mock';
  return process.env['JEV_BACKEND']?.trim() === 'local' ? 'local' : 'gateway';
}

/** Who answers live requests, named for banners, footers and ledgers. */
export function backendLabel(): string {
  return activeBackend() === 'local'
    ? `local Laya proxy at ${localJevUrl()} (Jev-compatible API, not Jev)`
    : 'Jev via Vercel AI Gateway';
}

/** True for real inference: Jev through Gateway, or the explicitly selected local proxy. */
export function isLiveJev(): boolean {
  const mock = process.env['JEV_MOCK'];
  if (mock === '1') return false;
  if (mock !== undefined && mock !== '' && mock !== '0') {
    throw new Error('JEV_MOCK must be 0 (live Jev) or 1 (explicit offline fixtures).');
  }
  const backend = process.env['JEV_BACKEND']?.trim();
  if (backend === 'local') return true;
  if (backend !== undefined && backend !== '' && backend !== 'gateway') {
    throw new Error('JEV_BACKEND must be gateway (default, Jev via Vercel AI Gateway) or local (Laya proxy, not Jev).');
  }
  if (!gatewayCredential()) {
    throw new Error(
      'AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is required for Jev through Vercel AI Gateway. ' +
        'No TYPESAFE_API_KEY is needed. ' +
        'Set it in .env for npm run commands or export it in your environment. ' +
        'Without Gateway access, JEV_BACKEND=local uses the local Laya proxy (npm run local-jev; not Jev). ' +
        'For scripted fixtures only (not model inference), explicitly set JEV_MOCK=1 ' +
        'or run npm run all:mock.',
    );
  }
  return true;
}

/** A free Jev credential must not silently enable paid generative models. */
export function isLiveGeneration(): boolean {
  if (process.env['JEV_MOCK'] === '1') return false;
  const enabled = process.env['AI_GATEWAY_GENERATIVE'];
  if (enabled === undefined || enabled === '' || enabled === '0') return false;
  if (enabled !== '1') throw new Error('AI_GATEWAY_GENERATIVE must be 0 or 1.');
  if (!gatewayCredential()) {
    throw new Error('AI_GATEWAY_GENERATIVE=1 requires AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN.');
  }
  return true;
}

export function createClient(script?: MockScript): ExampleClient {
  if (isLiveJev() && activeBackend() === 'local') {
    return {
      client: new TypeSafeClient({
        // The proxy binds to loopback and ignores the key; the SDK requires one.
        apiKey: 'local-jev-proxy',
        baseURL: localJevUrl(),
        defaultModel: 'local-laya',
        // CPU inference is serialized in the proxy; concurrent example calls queue behind each other.
        timeout: Number(process.env['LOCAL_JEV_TIMEOUT_MS']) || 120_000,
        retry: { maxRetries: 0 },
      }),
      live: true,
    };
  }
  if (isLiveJev()) {
    return {
      client: new TypeSafeClient({
        apiKey: gatewayCredential()!,
        baseURL: process.env['AI_GATEWAY_TYPESAFE_BASE_URL']?.trim() || JEV_GATEWAY_URL,
        defaultModel: process.env['TYPESAFE_DEFAULT_MODEL']?.trim() || JEV_GATEWAY_MODEL,
      }),
      live: true,
    };
  }

  return {
    client: new TypeSafeClient({
      apiKey: 'offline-mock-key',
      fetch: mockFetch(script),
      // Nothing can fail transiently against an in-process mock.
      retry: { maxRetries: 0 },
    }),
    live: false,
  };
}
