# Jev examples

Working examples of [Jev](https://docs.typesafe.ai) — TypeSafe AI's "System One"
evaluation model — using the official [`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk),
paired with the [Vercel AI SDK](https://ai-sdk.dev) and
[AI Gateway](https://vercel.com/ai-gateway) for the generative half of an agent.

Every example runs right now, with no API key.

```bash
npm install
node examples/01-quickstart.ts
```

---

## What Jev is

Jev is not a chat model. It does not write text, and there is nothing to parse.

You hand it a **state** — a string, an object, a message list, whatever you
already have — and a map of **typed questions**. It returns typed answers with
probability distributions attached.

```ts
import { TypeSafeClient, choice, noul, score } from '@typesafe-ai/sdk';

const client = new TypeSafeClient(); // reads TYPESAFE_API_KEY

const { answers } = await client.systemOne({
  state: { subject: 'Charged twice', body: '...' },
  questions: {
    department: choice('Which team owns this?', { billing: '...', technical: '...' }),
    severity: score('How severe?', ['Cosmetic', 'Degraded', 'Blocked', 'Outage']),
    wantsRefund: noul('Is the customer asking for money back?'),
  },
});

answers.department.choice;        // 'billing'  (typed to the option keys)
answers.department.probabilities; // { billing: 0.52, technical: 0.30, ... }
answers.severity.score;           // 2.70, continuous in [0, 3]
answers.wantsRefund.noul;         // 0.97
```

Three primitives, and that is the whole surface:

| Primitive  | Builder    | You get back                                           |
| ---------- | ---------- | ------------------------------------------------------ |
| **Choice** | `choice()` | `choice` + `probabilities` over your option keys        |
| **Score**  | `score()`  | `score` in `[0, levels-1]` + `probabilities` per level  |
| **Noul**   | `noul()`   | `noul` — a probability in `[0, 1]`                      |

("Noul" is TypeSafe's term for a yes/no probability. The AI SDK renames it to
`boolean`/`probability`; see [`docs/SDKS.md`](docs/SDKS.md) for the full
mapping, which is where porting bugs come from.)

Two properties drive the whole design:

1. **Questions are evaluated in parallel and in isolation.** Ten questions cost
   roughly what one costs in latency. Adding a question cannot degrade the
   answer to another one.
2. **Questions cannot read each other's answers.** If decision B depends on
   answer A, that is a second request — and usually it is a branch in your code
   instead.

It is cheap enough to put in a loop: **\$0.042 per 1M input tokens**, zero output
tokens, because there is no output to generate.

## What Jev is not

It is not an agent, a planner, a harness, or a tool router. TypeSafe's own
position is that **Jev is never the harness** — it is a decision point inside a
loop your code owns:

| Job                    | Owner               |
| ---------------------- | ------------------- |
| Interpret, propose     | a generative model  |
| **Judge, classify, gate** | **Jev**          |
| Decide whether to act  | **your code**       |
| Execute                | your tool runner    |
| Update state           | **your code**       |
| Explain the result     | a generative model  |

Example 03 is built around that table.

---

## The examples

### [`01-quickstart.ts`](examples/01-quickstart.ts) — one request, five questions

Triages a support ticket: one Choice, two Scores, two Booleans, in a single
call. Shows the distributions, then makes the routing decision in plain
TypeScript — including refusing to auto-route when confidence is low.

```
Choice — department: billing
  billing    ████████████············  52.0%
  technical  ███████·················  30.0%
  sales      ███·····················  12.0%
  selected probability 52.0% · confidence 18.9%

Score — severity: 2.70 of 3
  3 Revenue-affecting outage with no workaround  ███████████████████·····  77.5%
  2 A core workflow is blocked                   ████····················  16.9%

Routing decision (plain code)
  route to        triage queue (confidence 18.9% too low to auto-route)
  refund          auto-open refund case
```

The point: **ask everything at once, then decide in code.** Extra questions are
close to free, so ask the speculative ones too — you can ignore an answer, but
you cannot go back in time for it.

### [`02-judge-rubrics.ts`](examples/02-judge-rubrics.ts) — model-as-a-judge with rubrics

Scores three candidate responses against the same five-question rubric, then
combines dimensions with weights you own.

```
Per-dimension, normalized to 0..1
  candidate   factual  complete  tone
  model-a        0.97      0.97  0.90
  model-c        0.03      0.55  0.95

Composite score, same measurements, two weightings
  candidate   support-quality  brand-voice   verdict
  model-a               0.956        0.935   PASS
  model-c               0.372        0.595   FAIL

Hard gates tripped (checked separately, never weight-averaged)
  ✗ model-c: invents policy (97%), claims an irreversible action (95%)
```

Two rules this example exists to demonstrate:

1. **Normalize a Score by `levels - 1`.** A 4-level rubric returns `[0, 3]`.
2. **"Any serious violation" is a separate condition, never a small weight.** A
   weighted average is a *compensating* model: a great tone score will happily
   pay for a hallucinated refund policy. `model-c` writes the warmest reply in
   the set and is exactly the answer that costs you money.

Because the weights are ordinary numbers, changing what you value is a
coefficient change and not a prompt rewrite — the same measurements produce
both the `support-quality` and `brand-voice` rankings above.

### [`03-agent-harness.ts`](examples/03-agent-harness.ts) — Jev in a harness

Two models, two jobs. The **Vercel AI SDK** (`generateObject` + `gateway`)
proposes each next command. **Jev** judges it: which model to route to, whether
the command is `clear` or `caution`, whether it is irreversible, how much it
advances the goal, whether the goal is met, and whether the agent is stuck. The
loop, the budget and every actual decision are plain TypeScript.

```
Route  goal -> powerful (p=83.0%, confidence=34.2%)
  proposer: openai/gpt-6-astra via MockLanguageModelV4 (ai/test)

step 2  grep -c "OutOfMemoryError" /workspace/logs/checkout.log
  permission=clear p=93.0% · irreversible=2.0% · advances=2.40/3 · goalMet=18.0%
  RUN  17

step 3  rm -rf /workspace/logs/*.log && systemctl restart checkout
  permission=caution p=97.0% · irreversible=96.0% · advances=0.40/3 · goalMet=5.0%
  HOLD escalate to a human — classified caution, irreversible 96.0%

step 4  sed -n "1,80p" /workspace/logs/checkout.log
  permission=clear p=94.0% · advances=2.90/3 · goalMet=93.0%
  RUN  java.lang.OutOfMemoryError: Java heap space
  DONE goal met at 93.0%
```

The blocked command is fed back to the proposer as an `avoid` list, so the
generative model routes around the gate instead of retrying into it.

The permission gate mirrors Vercel's `eve` framework (`eve/tools/approval`,
`auto()`), which asks exactly **one** Choice question with id `permission` and
criteria `clear` / `caution`, then maps `clear` → approved and *everything
else, including a failed call* → human approval. Fail-closed is the whole
design: a timeout must not become a `rm -rf`.

Note the two-request structure. Routing happens first, because the per-step
questions are asked against a state that already includes the chosen model —
questions in one request cannot consume each other's answers.

### [`04-browser-use.ts`](examples/04-browser-use.ts) — browser use

The loop is `settle → describe → evaluate → act`. Your code enumerates the
interactive elements on the page and gives Jev their ids as Choice options, plus
a `none` option. The model picks from that list.

```
step 1  /pricing
  4 candidates · ~80 tokens of page state
  target=e1 p=46.0% · confidence=20.6% · goalMet=1.0%
  AMBIGUOUS distribution is split; not clicking on a coin flip
  shortlist for the caller or a person:
    e1 "Accept all cookies" 46.0%
    e2 "Reject non-essential cookies" 31.4%

step 3  /pricing/pro
  target=none p=86.0% · confidence=55.5% · goalMet=96.0%
  DONE answer found on this page
```

Why this shape beats "ask an LLM for a selector":

- **The model cannot invent a selector.** It chooses among elements that already
  exist in your DOM snapshot. There is nothing to hallucinate and nothing to
  parse.
- **A split distribution is a usable signal**, not a failure. Community
  implementations turn it into a status enum — `done`, `likely_done`,
  `needs_login`, `needs_confirmation`, `ambiguous`, `blocked`, `stuck` — and the
  caller decides. This example does the same.
- **The token cost is small enough to run every step.** Community write-ups
  report roughly ~8k tokens for a task where a Playwright-MCP agent burned
  ~557k. Those are self-reported, unaudited numbers, but the direction is not
  surprising: you send element labels, not a page.

Prior art worth reading, all MIT and all unofficial — there is no official
TypeSafe browser example: [`Ying-Kai-Liao/jev-browser`](https://github.com/Ying-Kai-Liao/jev-browser)
(best-documented), [`jkudish/jev-browser`](https://github.com/jkudish/jev-browser),
[`moritzkremb/jev-voice-browser`](https://github.com/moritzkremb/jev-voice-browser).

This example simulates a three-page site so it runs without Playwright. The
`describe → evaluate → act` contract is what you would keep.

### [`examples/python/`](examples/python) — LangChain

LangChain's TypeSafe integration is **Python-only**; there is no
`@langchain/typesafe` on npm. These two examples need `TYPESAFE_API_KEY` and do
not run offline.

- [`judge_rubric.py`](examples/python/judge_rubric.py) — the rubric judge from
  example 02, using `TypeSafeClassifier` with `Score`, `Noul` and `Choice`.
- [`langchain_harness.py`](examples/python/langchain_harness.py) —
  `ModelRouterMiddleware` and `AutoModeMiddleware`, which are the routing and
  permission gates from example 03 as drop-in middleware, plus a custom
  `before_agent` middleware showing the general shape.

```bash
pip install -r examples/python/requirements.txt
```

`langchain-typesafe` is `0.0.1a3` — alpha, with one breaking change already
behind it, and the middleware module is explicitly experimental. Pin it.
Note also that `AutoModeMiddleware` **refuses** a risky call with an error
`ToolMessage`; it does not prompt. Pair it with human-in-the-loop middleware if
you want a person in the path.

---

## Running the examples

```bash
npm install
node examples/01-quickstart.ts   # or: npm run quickstart
npm run all                      # all four, in order
```

There is no build step. The examples are `.ts` files executed directly by
**Node ≥ 22.18**, which strips types natively. The dependencies are the real
published SDKs — `@typesafe-ai/sdk`, `ai`, `@ai-sdk/gateway` and `zod` — and
nothing in `src/` reimplements any of them.

### Offline by default, live with one env var

Without a key, the examples inject a mock `fetch` into the real
`TypeSafeClient` ([`src/mock-fetch.ts`](src/mock-fetch.ts)) and a
`MockLanguageModelV4` from `ai/test` into the real `generateObject` call. The
SDKs' request building, validation, retries and error handling all stay on the
live code path; only the HTTP response bodies are manufactured.

With a key, the exact same code calls the real services:

```bash
export TYPESAFE_API_KEY=...       # get one at typesafe.ai
export AI_GATEWAY_API_KEY=...     # only needed for example 03's proposer
node examples/01-quickstart.ts
```

`JEV_MOCK=1` forces the mocks even with keys. The SDK also honors
`TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL` and `TYPESAFE_LOG_LEVEL` — see
[`.env.example`](.env.example).

**One honest caveat about the mock.** It reproduces Jev's *contract* exactly —
distributions sum to 1, a Score is the probability-weighted mean of its levels,
a Choice is the argmax — but it approximates confidence as `1 - normalizedEntropy`.
That makes two-option questions look under-confident (a 83/17 split reports
34.2%). Real Jev calibrates confidence differently. Read the mock's confidence
numbers as illustrative, and do not port that formula.

---

## Repo layout

```
src/client.ts     createClient() — real TypeSafeClient, mock fetch when offline
src/mock-fetch.ts offline Fetch answering POST /v1/systemone
src/proposer.ts   the AI SDK half: generateObject + gateway, MockLanguageModelV4 offline
src/rubric.ts     normalizeScore, weightedScore, gate, isAmbiguous, rankedOptions
src/ui.ts         console formatting
examples/         the four TypeScript examples, plus python/
docs/SDKS.md      which SDK to use, and the naming trap between them
```

Everything in `src/` is composition and presentation. There is no hand-written
API client here: `@typesafe-ai/sdk` already does request building, literal-typed
answers, retry-with-jitter and typed errors, and the AI SDK already does
structured generation and Gateway routing.

### About `experimental_evaluate`

The AI SDK has a first-class evaluation API, `experimental_evaluate`, which is
documented and merged in `vercel/ai` — but **not in a published release**.
`ai@7.0.101` does not export it, `@ai-sdk/gateway@4.0.81` has no
`evaluationModel`, and `@ai-sdk/typesafe-ai` is not resolvable. So Jev is called
through its own SDK, and the AI Gateway is used for what it can do today:
generation. When the export ships, the question and answer shapes map
one-to-one — [`docs/SDKS.md`](docs/SDKS.md) has the table.

**Not verified here:** no request in this repo has been run against the live
TypeSafe API or the live Gateway — there was no API key in the build
environment.

---

## Six things worth internalizing

1. **Ask atomic questions.** "Is this a good response?" is three questions
   wearing a trench coat. Decompose, then combine in code.
2. **Ask them all at once.** Parallel and isolated means extra questions are
   nearly free in latency and cannot hurt each other's answers.
3. **Keep the distribution.** The argmax throws away the most useful thing you
   were given. A split distribution means *escalate*, not *guess*.
4. **Confidence is concentration, not correctness.** It tells you the model was
   decisive. It does not tell you the model was right, and it is not permission
   to act.
5. **Gates are conditions, not weights.** Anything that must never happen gets
   its own check outside the average.
6. **Calibrate your thresholds.** The `0.7` and `0.75` in these examples are
   placeholders. Run labeled examples through your rubric and pick real numbers.

## References

- [TypeSafe docs](https://docs.typesafe.ai) — primitives, patterns, API reference
- [Jev on the Vercel AI Gateway](https://vercel.com/ai-gateway/models/jev)
- [AI SDK evaluation docs](https://ai-sdk.dev/docs/ai-sdk-core/evaluation) and
  [`experimental_evaluate` reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/evaluate)
- [`vercel/ai` evaluate examples](https://github.com/vercel/ai/tree/main/examples/ai-functions/src/evaluate)
- [`langchain-typesafe` on PyPI](https://pypi.org/project/langchain-typesafe/) (Python, alpha)
