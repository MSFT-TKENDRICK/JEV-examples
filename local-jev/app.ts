/**
 * A local HTTP server with the TypeSafe `systemOne` surface: `POST /v1/systemone`,
 * `GET /v1/models`, plus `GET /health`.
 *
 * The decision engine is injected, so this file carries no model dependency and
 * the root test suite can drive it through the real `@typesafe-ai/sdk` client.
 * Every response names the model that actually answered; it never claims Jev.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { EntryType } from '@typesafe-ai/sdk';
import {
  ProxyError,
  parseSystemOneRequest,
  toLayaQuestions,
  toTypeSafeAnswers,
  type LayaQuestion,
  type LayaResult,
} from './protocol.ts';

/** Input the backend would silently discard at its trained limits; reported per question. */
export interface FidelityIssue {
  question: string;
  /** `option_capped` is a fixed per-option cap in the package; only it survives `extend`. */
  kind: 'option_capped' | 'instructions_truncated' | 'options_truncated' | 'state_truncated';
  detail: string;
}

export interface ContextLimits {
  /** Whole sequence: instructions, options and state. */
  maxLen: number;
  /** Instructions plus options. */
  headMaxLen: number;
}

export interface Fit {
  issues: FidelityIssue[];
  /** Smallest limits (never below the trained ones) at which only `option_capped` input is dropped. */
  needed: ContextLimits;
}

export interface DecisionEngine {
  /** Reported as `model` on every answer and listed by `GET /v1/models`. */
  readonly model: string;
  readonly description: string;
  readonly releaseDate: string;
  readonly trained: ContextLimits;
  /** Longest sequence the encoder accepts at all. */
  readonly maxPositions: number;
  inspect(state: EntryType, questions: Record<string, LayaQuestion>): Fit;
  systemOne(state: EntryType, questions: Record<string, LayaQuestion>, context?: ContextLimits): Promise<LayaResult>;
}

/**
 * What to do with input longer than Laya was trained on (512 tokens, 192 of them for the question):
 * - `extend` (default): run at the length the input needs, up to the encoder's limit, so nothing is dropped.
 *   The request is accepted like Jev would accept it; answers on it are outside Laya's training length.
 * - `reject`: 422, so every answer comes from in-distribution input.
 * - `truncate`: Laya's own behaviour — answer from whatever fits.
 */
export type OverflowPolicy = 'extend' | 'reject' | 'truncate';

export interface LocalJevOptions {
  overflow?: OverflowPolicy;
  maxBodyBytes?: number;
  log?: (line: string) => void;
}

const MAX_BODY_BYTES = 1_000_000;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text).toString(),
    ...headers,
  });
  res.end(text);
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new ProxyError(413, 'request_too_large', `request body exceeds ${limit} bytes`);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ProxyError(400, 'invalid_json', 'request body is not valid JSON');
  }
}

export function createLocalJevServer(engine: DecisionEngine, options: LocalJevOptions = {}): Server {
  const overflow = options.overflow ?? 'extend';
  const limit = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const log = options.log ?? (() => {});
  const identity = { 'x-local-jev-backend': 'laya', 'x-local-jev-model': engine.model };
  // One CPU-bound forward pass at a time keeps latency predictable.
  let queue: Promise<unknown> = Promise.resolve();

  return createServer(async (req, res) => {
    const requestId = randomUUID();
    const headers = { ...identity, 'x-typesafe-request-id': requestId };
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/health' && req.method === 'GET') {
        send(res, 200, { status: 'ok', jev: false, backend: 'laya', model: engine.model, rss_bytes: process.memoryUsage().rss }, headers);
        return;
      }
      if (url.pathname === '/v1/models' && req.method === 'GET') {
        send(res, 200, { models: [{ name: engine.model, description: engine.description, release_date: engine.releaseDate }] }, headers);
        return;
      }
      if (url.pathname !== '/v1/systemone') throw new ProxyError(404, 'not_found', `no route for ${url.pathname}`);
      if (req.method !== 'POST') throw new ProxyError(405, 'method_not_allowed', 'use POST /v1/systemone');

      const parsed = parseSystemOneRequest(await readJson(req, limit));
      const laya = toLayaQuestions(parsed.questions);
      const { issues, needed } = engine.inspect(parsed.state, laya);
      const trained = engine.trained;
      const fitsEncoder = needed.maxLen <= engine.maxPositions;
      const context = overflow === 'extend' && fitsEncoder ? needed : trained;
      const dropped = overflow === 'extend' && fitsEncoder ? issues.filter((i) => i.kind === 'option_capped') : issues;
      if (dropped.length > 0 && overflow !== 'truncate') {
        const reason =
          overflow === 'extend' && !fitsEncoder
            ? `the request needs ${needed.maxLen} tokens, over the encoder's ${engine.maxPositions}-token limit, and `
            : '';
        throw new ProxyError(
          422,
          'context_limit',
          `${reason}local Laya would silently drop input: ${dropped.map((i) => `${i.question} (${i.detail})`).join('; ')}. ` +
            'Shorten the state or options, or set LOCAL_JEV_OVERFLOW=truncate to answer from the input that fits.',
          dropped,
        );
      }
      const extended = context.maxLen > trained.maxLen || context.headMaxLen > trained.headMaxLen;
      const status = extended ? 'extended' : dropped.length > 0 ? 'truncated' : 'none';

      const started = performance.now();
      const run = queue.then(() => engine.systemOne(parsed.state, laya, context));
      queue = run.catch(() => {});
      let result: LayaResult;
      try {
        result = await run;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ProxyError(422, 'backend_rejected', `local Laya rejected the request: ${message}`);
      }
      const latency = Math.round(performance.now() - started);
      const answers = toTypeSafeAnswers(parsed.questions, result);
      log(
        `${requestId} ${Object.keys(answers).length}q ${result.usage.input_tokens}tok ${latency}ms` +
          (parsed.requestedModel ? ` requested=${parsed.requestedModel}` : '') +
          (status === 'none' ? '' : ` ${status.toUpperCase()} context=${context.maxLen}/${context.headMaxLen}`),
      );
      send(res, 200, { model: engine.model, answers, usage: result.usage }, {
        ...headers,
        'x-local-jev-latency-ms': String(latency),
        'x-local-jev-overflow': status,
        'x-local-jev-context': `${context.maxLen}/${context.headMaxLen}`,
      });
    } catch (error) {
      const failure =
        error instanceof ProxyError ? error : new ProxyError(500, 'internal_error', error instanceof Error ? error.message : String(error));
      log(`${requestId} ${failure.status} ${failure.type}: ${failure.message}`);
      send(
        res,
        failure.status,
        { error: { type: failure.type, message: failure.message, ...(failure.details === undefined ? {} : { details: failure.details }) } },
        headers,
      );
    }
  });
}
