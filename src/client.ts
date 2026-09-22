/**
 * Builds the TypeSafe client the examples use.
 *
 * With `TYPESAFE_API_KEY` set, this is just `new TypeSafeClient()` and the calls
 * are real. Without one, the same client is handed an offline `fetch` so the
 * examples still run. The SDK code path is identical either way.
 */

import { TypeSafeClient } from '@typesafe-ai/sdk';
import type { MockScript } from './mock-fetch.ts';
import { mockFetch } from './mock-fetch.ts';

export interface ExampleClient {
  client: TypeSafeClient;
  /** True when calls go to the real API. */
  live: boolean;
}

export function createClient(script?: MockScript): ExampleClient {
  const apiKey = process.env['TYPESAFE_API_KEY'];
  const live = Boolean(apiKey) && process.env['JEV_MOCK'] !== '1';

  if (live) {
    // Model, base URL, retries and timeouts all have sensible defaults and
    // environment fallbacks; see TypeSafeClientConfig.
    return { client: new TypeSafeClient(), live: true };
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
