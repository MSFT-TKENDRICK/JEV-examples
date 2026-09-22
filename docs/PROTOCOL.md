# The Jev wire protocol, and how it maps to `experimental_evaluate`

This repo calls Jev through a ~350-line client in [`src/jev.ts`](../src/jev.ts)
instead of the `ai` package. This document explains exactly what that client
sends, where the shape came from, and how to swap it out for the official API
when that API ships.

## Why a hand-written client

The official surface is `experimental_evaluate` from the `ai` package:

```ts
import { experimental_evaluate } from 'ai';
```

It is documented on ai-sdk.dev, and it exists in `vercel/ai` on `main`
(`examples/ai-functions/src/evaluate/`, `packages/gateway/src/gateway-evaluation-model.ts`).
It is **not** in a published `ai` release yet — verified against `ai@7.0.101`,
whose CJS and ESM entrypoints both lack the export, and against the `canary` and
`beta` dist-tags. `@ai-sdk/typesafe-ai` is likewise not resolvable.

Rather than write examples against an API nobody can install, this repo speaks
the Gateway's evaluation-model protocol directly. The types and the request body
are the same ones `@ai-sdk/gateway` uses, so migrating later is a swap of the
call site, not a rewrite of the examples.

## Request

```http
POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model
Authorization: Bearer $AI_GATEWAY_API_KEY
Content-Type: application/json
ai-evaluation-model-specification-version: 4
ai-model-id: typesafe-ai/jev
```

```json
{
  "state": { "anything": "JSON-serializable" },
  "questions": {
    "urgency": {
      "type": "choice",
      "instructions": "How urgent is this ticket?",
      "criteria": { "low": "...", "high": "..." }
    },
    "clarity": {
      "type": "score",
      "instructions": "How clearly is the problem described?",
      "criteria": ["Unintelligible", "Vague", "Clear", "Reproducible"]
    },
    "needsHuman": {
      "type": "boolean",
      "instructions": "Does this require a human?",
      "criteria": { "true": "...", "false": "..." }
    }
  },
  "providerOptions": {}
}
```

Notes that matter in practice:

- The base path is `/v4/ai`, **not** `/v1`. Some third-party write-ups cite a
  `POST https://ai-gateway.vercel.sh/v1/evaluate` route with `model` in the
  body. That does not match the Gateway source. `src/jev.ts` uses the
  source-verified route and exposes `JEV_BASE_URL` if you need to override it.
- The model id goes in the `ai-model-id` **header**, not the body.
- Every question is evaluated in parallel, in isolation, against the same
  `state`. Questions cannot read each other's answers. If decision B depends on
  answer A, that is a second request.
- `state` may be a string, an object, or an array. A message list is a perfectly
  good state — no serialization ceremony needed.

## Response

```json
{
  "answers": {
    "urgency":    { "type": "choice",  "choice": "high", "probabilities": { "low": 0.09, "high": 0.91 } },
    "clarity":    { "type": "score",   "score": 2.4,     "probabilities": { "0": 0.02, "1": 0.12, "2": 0.30, "3": 0.56 } },
    "needsHuman": { "type": "boolean", "probability": 0.83 }
  },
  "rounding": { "probabilityDecimals": 3, "scoreDecimals": 2 },
  "usage": { "inputTokens": 512, "outputTokens": 0 },
  "warnings": [],
  "providerMetadata": { "typesafe": { "confidence": { "urgency": 0.74, "clarity": 0.41 } } }
}
```

- `score` is a probability-weighted mean over level indices, so it is
  continuous in `[0, levels - 1]`. To normalize, divide by `levels - 1` — see
  `normalizeScore` in [`src/rubric.ts`](../src/rubric.ts).
- `outputTokens` is `0`. Jev does not generate text. You pay for input only
  (\$0.042 / 1M input tokens at the time of writing).
- `warnings[].type` is one of `unsupported`, `compatibility`, `deprecated`,
  `other`.
- Confidence is **not** on the answer. It lives under
  `providerMetadata.typesafe.confidence`, keyed by question id. `confidenceOf()`
  in `src/jev.ts` wraps that lookup.

## AI SDK vs native TypeSafe naming

The two APIs describe the same model with different words. This is the single
biggest source of porting bugs.

| Concept          | Vercel AI SDK                        | Native TypeSafe / LangChain |
| ---------------- | ------------------------------------ | --------------------------- |
| Yes/no question  | `type: 'boolean'`                    | `Noul`                      |
| Its answer field | `probability` (always present)       | `noul`                      |
| Confidence       | `providerMetadata.typesafe.confidence[id]` | `confidence` on the answer |
| Score legend     | not returned                         | `legend` on the answer      |
| Usage fields     | `inputTokens` / `outputTokens`       | `input_tokens` / `output_tokens` |
| Endpoint         | `/v4/ai/evaluation-model`            | `POST https://api.typesafe.ai/v1/systemone` |
| Auth             | `AI_GATEWAY_API_KEY`                 | `TYPESAFE_API_KEY`          |
| Model id         | `typesafe-ai/jev`                    | `jev-latest`                |

This repo uses the AI SDK vocabulary throughout so the migration path stays
short. The Python examples under `examples/python/` use the native vocabulary,
because that is what `langchain-typesafe` exposes.

## Migrating to `experimental_evaluate`

Once the `ai` package publishes the export, the change is local to the call
site. Today:

```ts
import { evaluate } from '../src/jev.ts';

const result = await evaluate({ state, questions });
result.answers.urgency.choice;
confidenceOf(result, 'urgency');
```

After:

```ts
import { experimental_evaluate as evaluate } from 'ai';

const result = await evaluate({
  model: 'typesafe-ai/jev', // string ids resolve through the Gateway
  state,
  questions,
  maxRetries: 2, // default
});
result.answers.urgency.choice;
result.providerMetadata?.typesafe?.confidence?.urgency;
```

The question and answer shapes are identical, so the rubric helpers, the mock
transport's expectations, and every example body carry over unchanged.

Other provider forms, for reference:

```ts
import { gateway } from '@ai-sdk/gateway';
gateway.evaluationModel('typesafe-ai/jev-latest');

import { typeSafeAi } from '@ai-sdk/typesafe-ai'; // not yet resolvable
typeSafeAi.evaluationModel('jev-latest');
```

For tests, the SDK ships `Experimental_EvaluationMockModelV4` from `ai/test`,
which replaces the role that [`src/mock.ts`](../src/mock.ts) plays here.

## Errors

The client surfaces failures as `JevError` with the HTTP status attached. The
statuses worth handling explicitly:

| Status | Meaning                | Suggested handling                    |
| ------ | ---------------------- | ------------------------------------- |
| 401    | Bad or missing key     | Fail fast; do not retry               |
| 422    | Malformed question set | Fail fast; it is a bug in your code   |
| 429    | Rate limited           | Retry with backoff                    |
| 529    | Overloaded             | Retry with backoff                    |

`src/jev.ts` retries 429/5xx with exponential backoff and treats 4xx other than
429 as terminal.

## Things this repo has not verified

Stated plainly, because guessing here would be worse than saying so:

- No request in this repo has been executed against the live Gateway or against
  `api.typesafe.ai`. There was no API key in the build environment. The protocol
  above is read from `vercel/ai` source, not from a captured response.
- The exact `ai` version that will ship `experimental_evaluate` is unknown. The
  docs say "AI SDK 7 or later".
- The competing `/v1/evaluate` route is documented here only so you recognize it
  if you meet it elsewhere.
