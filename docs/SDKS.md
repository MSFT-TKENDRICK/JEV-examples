# Which SDK to use for Jev

This repository calls **`typesafe-ai/jev` through Vercel AI Gateway**, using the
existing official `@typesafe-ai/sdk`. Vercel's
[TypeSafe-compatible API](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)
supports this directly. No direct TypeSafe account key or API endpoint is needed.

**Repository requirement:** the default examples must run real Jev through
Vercel AI Gateway, not the direct vendor API and not an implicit mock. Keep the
published TypeSafe SDK on Vercel's supported compatibility route; do not introduce
a hand-written protocol client or adapter to obtain Gateway access. The Vercel AI
SDK remains the integration for optional generative arms.

As of **2026-10-08**, Vercel's
[model page for Jev](https://vercel.com/ai-gateway/models/jev) lists
**$0.042 per 1M input tokens** and a maximum output of 0 tokens. Earlier versions of
this document said Jev was **Free** on Vercel as of 2026-09-22. That listing has
changed. Authentication is still required. Check the catalog for current pricing and
account limits; this is not a promise about future prices, other models, or
infrastructure costs.

## 1. `@typesafe-ai/sdk` through Vercel — what this repo uses

```bash
npm install @typesafe-ai/sdk
```

Configure the endpoint, credential and model explicitly rather than relying on
the SDK's direct-provider defaults:

```ts
import { TypeSafeClient, choice, noul, score } from '@typesafe-ai/sdk';

const apiKey = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
if (!apiKey) throw new Error('Set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN');

const client = new TypeSafeClient({
  apiKey,
  baseURL: 'https://ai-gateway.vercel.sh/typesafe',
  defaultModel: 'typesafe-ai/jev',
});

const { answers, usage, model } = await client.systemOne({
  state: { subject: 'Charged twice', body: '...' },
  questions: {
    department: choice('Which team owns this?', { billing: '...', technical: '...' }),
    severity: score('How severe?', ['Cosmetic', 'Degraded', 'Blocked', 'Outage']),
    wantsRefund: noul('Is the customer asking for money back?'),
  },
});

answers.department.choice;        // typed to 'billing' | 'technical'
answers.department.probabilities; // probability per offered option
answers.severity.legend;          // the rubric, keyed by score
answers.wantsRefund.noul;         // 0..1
```

The SDK still supplies literal-typed answers, retry handling, typed errors and the
`systemOne()` request/response mapping. We are not replacing it with a hand-written
HTTP client. The compatibility route preserves TypeSafe field names.

The repository pins `@typesafe-ai/sdk` at `^0.6.0`. Version 0.6.0 accepts score
criteria only as an array of at least two labels, ordered lowest to highest. The
object form that 0.5.x accepted, such as `{ 0: 'none', 1: 'minor' }`, throws a
`TypeSafeError`. Its response declarations match 0.5.7.

### Repository configuration

[`src/client.ts`](../src/client.ts) centralizes this configuration:

| Setting | Purpose |
|---|---|
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway credential |
| `VERCEL_OIDC_TOKEN` | Alternative Vercel credential when an API key is not supplied |
| `AI_GATEWAY_TYPESAFE_BASE_URL` | Optional loopback/private-proxy override; defaults to `https://ai-gateway.vercel.sh/typesafe` |
| `TYPESAFE_DEFAULT_MODEL` | Defaults to `typesafe-ai/jev`; overriding the model may change pricing |
| `TYPESAFE_LOG_LEVEL` | SDK logging configuration |
| `JEV_MOCK=1` | Explicit scripted-fixture mode; no Jev network requests |
| `AI_GATEWAY_GENERATIVE=1` | Separate opt-in for potentially paid TypeScript generative models |
| `JEV_BACKEND=local` | Opt-in: send the same SDK requests to the local Laya proxy in [`local-jev/`](../local-jev/README.md). Not Jev; runs are labelled `LOCAL_MODEL` |
| `LOCAL_JEV_URL` / `LOCAL_JEV_TIMEOUT_MS` | Local proxy address (default `http://127.0.0.1:8765`) and SDK timeout (default 120 s) |

Missing Gateway credentials are a setup error, not an offline-mode selector.
Only an explicit `JEV_BACKEND=local` selects the local proxy, which is real
inference by a different model (Laya), never presented as Jev. See
[`local-jev/README.md`](../local-jev/README.md) for what its API parity does and
does not cover.
The shared client does not fall back to `TYPESAFE_API_KEY` or `TYPESAFE_BASE_URL`.
Copy `.env.example` to `.env`, set the Gateway credential, and run
`npm run quickstart`. Npm example commands load `.env` with
`--env-file-if-exists=.env`; direct `node examples/...` commands need that flag
or exported environment variables.

For reproducible fixture runs use `npm run all:mock` or explicitly set
`JEV_MOCK=1`. A mock `fetch` from [`src/mock-fetch.ts`](../src/mock-fetch.ts)
supplies manufactured responses while exercising the SDK code path. The SDK
does not runtime-validate every response field, so fixture types and checks
remain important.

**A Gateway credential does not enable paid generation.** The proposer, triager and
generative browser control replay disclosed scripted outputs by default, even
when a Gateway credential is present. Only `AI_GATEWAY_GENERATIVE=1` opts those
TypeScript arms into live generation; the chosen generative models can incur
charges. `JEV_MOCK=1` still forces fixtures.

## 2. Python integration

See [`examples/python.md`](examples/python.md) for the `langchain-typesafe` examples.
Their Jev client is also configured for Vercel's TypeSafe-compatible route with
Gateway credentials, not direct TypeSafe authentication. `judge_rubric.py` needs
only the Gateway credential. `langchain_harness.py` additionally requires
`OPENAI_API_KEY` and invokes potentially paid OpenAI generation when run; this is
separate from Jev's catalog pricing and from the TypeScript `AI_GATEWAY_GENERATIVE=1`
switch. A Gateway credential alone cannot activate those OpenAI calls. Middleware APIs
remain experimental in the pinned integration.

A LangChain.js package also exists: `@langchain/typesafe` (npm, 0.0.2 as of
2026-10-08). Its documented default reads a direct `TYPESAFE_API_KEY`, which this
repository does not use. Evaluate it against the Gateway route before relying on it here.

## 3. Vercel Decision API — an alternative, not a prerequisite

Vercel now calls these models **decision models**; they were formerly *evaluation
models*. Its [Decision documentation](https://vercel.com/docs/ai-gateway/modalities/decision)
describes the AI SDK route as `experimental_decide`, which needs `ai` 7.0.128 or later.
`experimental_evaluate` remains a deprecated alias. The public HTTP endpoint is still
`POST https://ai-gateway.vercel.sh/v1/evaluate`, and the Decision API also supports
the TypeSafe-compatible route used here.

This repository does not need an `experimental_decide` or `experimental_evaluate`
export to call Jev through Gateway, nor does it depend on an internal wire protocol.
For a new AI SDK integration, follow the current Vercel documentation and verify the
exports of the package versions you install. When this was checked (2026-10-08), the
newest `ai` release on npm was 7.0.127, which does not yet provide `experimental_decide`.

### Naming differences

| Concept | TypeSafe-compatible API used here | Vercel Decision API |
|---|---|---|
| Yes/no question | `noul` | `boolean` |
| Its answer field | `noul` | `probability` |
| Choice result | `choice` + `probabilities` | `choice` + `probabilities` |
| Score result | `score` + `probabilities` | `score` + `probabilities` |
| Usage fields | `input_tokens`, `output_tokens` | `inputTokens`, `outputTokens` |
| HTTP endpoint | `/typesafe/v1/systemone` | `/v1/evaluate` |
| Model | `typesafe-ai/jev` | `typesafe-ai/jev` |

Both endpoints are on `https://ai-gateway.vercel.sh` and accept Gateway
authentication. A `noul`/`boolean` answer is a probability, not an authorization
decision.

## Evidence boundary

The route and pricing above are grounded in Vercel documentation and its model
catalog, checked on 2026-10-08. They are not measurements from this repository.
The committed output and recording remain explicit fixture captures. Live
connectivity alone would not establish model quality, calibration or reliability.
