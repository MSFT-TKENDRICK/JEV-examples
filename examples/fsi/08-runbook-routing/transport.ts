/**
 * Scripted transports, including the ones that fail.
 *
 * `src/client.ts` already swaps the SDK's `fetch` for an offline implementation,
 * which is how every example here runs without a key. This module adds the two
 * failure transports example 08 needs, without touching the shared client:
 *
 * - **timeout** — the request never completes and the SDK's own timer fires.
 * - **malformed** — HTTP 200 with a structurally invalid answer. The SDK does
 *   not runtime-validate response bodies, so a missing `choice` or absent
 *   `probabilities` arrives as `undefined` at the call site rather than as an
 *   error. An application that reads `answers.first_runbook.choice` without
 *   checking will route on `undefined`.
 *
 * Both faults stay offline even when `TYPESAFE_API_KEY` is set: they exist to
 * exercise application paths, and firing them at the real service would prove
 * nothing while spending a request.
 */

import { TypeSafeClient } from '@typesafe-ai/sdk';
import type { Fetch } from '@typesafe-ai/sdk';
import { createClient } from '../../../src/client.ts';
import type { MockScript } from '../../../src/mock-fetch.ts';

export type Fault = 'timeout' | 'malformed';

/** Short, so the example finishes quickly; production budgets are not 400ms. */
const FAULT_TIMEOUT_MS = 400;

/** Hangs until the SDK's per-attempt timer aborts the request. */
const hangingFetch: Fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });

/** 200 OK, valid JSON, wrong shape — the failure mode a type system will not catch. */
const malformedFetch: Fetch = async () =>
  new Response(
    JSON.stringify({
      model: 'jev-latest',
      answers: {
        // No `choice`, no `probabilities`. Both are required by the SDK's types
        // and neither is checked at runtime.
        first_runbook: { type: 'choice', confidence: 0.91 },
        evidence_sufficient: { type: 'noul' },
      },
      usage: { input_tokens: 812, output_tokens: 0 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

export interface RoutingClient {
  client: TypeSafeClient;
  /** True only when calls reach the real API. Faults are always offline. */
  live: boolean;
}

/**
 * Builds the client for one incident.
 *
 * Without a fault this is the shared `createClient`, so the example uses the
 * real service when a key is present and the offline mock otherwise.
 */
export function routingClient(script: MockScript, fault?: Fault): RoutingClient {
  if (!fault) return createClient(script);

  return {
    client: new TypeSafeClient({
      apiKey: 'offline-mock-key',
      fetch: fault === 'timeout' ? hangingFetch : malformedFetch,
      timeout: FAULT_TIMEOUT_MS,
      // Retrying a scripted fault only makes the example slower.
      retry: { maxRetries: 0 },
    }),
    live: false,
  };
}
