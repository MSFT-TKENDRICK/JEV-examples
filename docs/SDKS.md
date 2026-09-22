# Which SDK to use for Jev

There are three ways to reach Jev from JavaScript or Python. Two of them work
today, one does not yet. This page says which is which, because the naming
differs between them and that is where the bugs come from.

## 1. `@typesafe-ai/sdk` — what this repo uses

The official TypeScript SDK, MIT licensed, published by TypeSafe.

```bash
npm install @typesafe-ai/sdk
```

```ts
import { TypeSafeClient, choice, noul, score } from '@typesafe-ai/sdk';

const client = new TypeSafeClient(); // reads TYPESAFE_API_KEY

const { answers, usage, model } = await client.systemOne({
  state: { subject: 'Charged twice', body: '...' },
  questions: {
    department: choice('Which team owns this?', { billing: '...', technical: '...' }),
    severity: score('How severe?', ['Cosmetic', 'Degraded', 'Blocked', 'Outage']),
    wantsRefund: noul('Is the customer asking for money back?'),
  },
});

answers.department.choice;        // typed to 'billing' | 'technical'
answers.department.confidence;    // on the answer itself
answers.severity.legend;          // the rubric, keyed by score
answers.wantsRefund.noul;         // 0..1
```

What it gives you that is worth not rewriting:

- **Literal-typed answers.** `choice()`, `score()` and `noul()` take `const`
  generics, so `answers.department.choice` is a union of your label strings and
  `answers.severity.probabilities` is keyed by your rubric indices.
- **Retries with jitter**, honoring `Retry-After` and `retry-after-ms`, with a
  configurable status list (`RetryPolicy`).
- **Typed errors**: `AuthenticationError`, `RateLimitError`,
  `UnprocessableEntityError`, `APIConnectionError`, `APITimeoutError`,
  `APIUserAbortError`, each carrying `status`, `headers`, `body` and
  `requestId`.
- **A `fetch` option**, which is how this repo runs offline — see
  [`src/mock-fetch.ts`](../src/mock-fetch.ts). The client, its request building
  and its error handling are all still on the real path. (It does *not*
  runtime-validate response bodies — `parseBody` is a `JSON.parse` — so a mock
  is trusted to emit the right shape.)
- `APIPromise` with `.withResponse()` and `.asResponse()` when you need the
  raw HTTP response or the `x-typesafe-request-id`.

Config precedence is explicit options → environment → defaults:
`TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`,
`TYPESAFE_LOG_LEVEL`.

## 2. `langchain-typesafe` — Python only

See [`examples/python/`](../examples/python). There is no `@langchain/typesafe`
on npm. The package is `0.0.1a3`, alpha, and its middleware module is
explicitly experimental — pin it.

## 3. `experimental_evaluate` from the AI SDK — not published yet

The Vercel AI SDK has a first-class evaluation API:

```ts
import { experimental_evaluate } from 'ai';
```

It is documented on ai-sdk.dev and the implementation is in `vercel/ai` on
`main` (`packages/gateway/src/gateway-evaluation-model.ts`, plus examples under
`examples/ai-functions/src/evaluate/`). It is **not in a published release**.
Verified at the time of writing:

| Package             | Latest    | Has evaluation support?                    |
| ------------------- | --------- | ------------------------------------------ |
| `ai`                | `7.0.101` | No `experimental_evaluate` export          |
| `@ai-sdk/gateway`   | `4.0.81`  | No `evaluationModel` on the provider       |
| `@ai-sdk/typesafe-ai` | —       | Not published                              |

`ai`'s `canary` (`7.0.0-canary.176`) and `beta` (`7.0.0-beta.187`) tags are both
older than `latest` and also lack it.

When it does ship, it will look like this, and the questions and answers map
one-to-one onto what this repo already does:

```ts
import { experimental_evaluate as evaluate } from 'ai';

const result = await evaluate({
  model: 'typesafe-ai/jev', // string ids resolve through the Gateway
  state,
  questions: {
    wantsRefund: { type: 'boolean', instructions: '...' },
  },
});
```

The advantage then is billing: the Gateway bills Jev like any other model
(\$0.042 / 1M input tokens, zero output tokens), so one key and one balance
cover both halves of an agent.

## The naming trap

The AI SDK and the native SDK describe the same model with different words.
This is the single biggest source of porting bugs.

| Concept          | `@typesafe-ai/sdk` / LangChain | Vercel AI SDK                              |
| ---------------- | ------------------------------ | ------------------------------------------ |
| Yes/no question  | `noul(...)`                    | `{ type: 'boolean' }`                      |
| Its answer field | `.noul`                        | `.probability`                             |
| Confidence       | `.confidence` on the answer    | `providerMetadata.typesafe.confidence[id]` |
| Score legend     | `.legend` on the answer        | not returned                               |
| Usage fields     | `input_tokens` / `output_tokens` | `inputTokens` / `outputTokens`           |
| Endpoint         | `POST https://api.typesafe.ai/v1/systemone` | `POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model` |
| Auth             | `TYPESAFE_API_KEY`             | `AI_GATEWAY_API_KEY`                       |
| Model id         | `jev-latest`                   | `typesafe-ai/jev`                          |

"Noul" is the native term for a yes/no probability. The AI SDK renames it to
`boolean`, which is a slightly unfortunate name for a number between 0 and 1 —
it is a probability, not a verdict, in both SDKs.

## The Gateway wire protocol, for reference

> ⚠️ **Unpublished, source-derived, and subject to change.** The block below was
> read from `vercel/ai` on `main`, where the evaluation model is implemented but
> not released. No request in this repo has ever been sent to it. Do not build
> another language's client against this until Vercel publishes the evaluation
> API — the header names and the version number can still move.

If you ever need to look at the traffic:

```http
POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model
Authorization: Bearer $AI_GATEWAY_API_KEY
Content-Type: application/json
ai-evaluation-model-specification-version: 4
ai-model-id: typesafe-ai/jev

{ "state": ..., "questions": { ... }, "providerOptions": {} }
```

The base path is `/v4/ai`, **not** `/v1`, and the model id travels in a header
rather than the body. Some third-party write-ups cite a
`POST https://ai-gateway.vercel.sh/v1/evaluate` route with `model` in the body;
that does not match the Gateway source. It is mentioned here only so you
recognize it if you meet it elsewhere.

The native route is simpler — `POST https://api.typesafe.ai/v1/systemone` with
`{ state, questions, model }` in the body and the API key in `Authorization`.

## Not verified here

Stated plainly, because guessing would be worse:

- No request in this repo has been executed against the live TypeSafe API or
  the live Gateway. There was no API key in the build environment. Everything
  above about request and response shape comes from the published SDK's types
  and from `vercel/ai` source, not from a captured response.
- The exact `ai` version that will ship `experimental_evaluate` is unknown. The
  docs say "AI SDK 7 or later".
