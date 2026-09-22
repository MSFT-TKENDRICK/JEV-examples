# Jev examples

Working examples of [Jev](https://docs.typesafe.ai) — TypeSafe AI's "System One"
evaluation model — using the official [`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk),
paired with the [Vercel AI SDK](https://ai-sdk.dev) and
[AI Gateway](https://vercel.com/ai-gateway) for the generative half of an agent.

Examples 01–04 run right now, with no API key and no setup beyond `npm install`.
Examples 05 and 06 drive a real Chrome and record it; they need a one-time
browser download, so they are opt-in.

```bash
npm install
node examples/01-quickstart.ts
```

### Jev vs a conventional generative agent

![Jev and a control model browsing the same site side by side](docs/media/jev-vs-control.gif)

Same task, same page, same driver, same click mechanics — only the decision
model differs. Left is Jev; right is an ordinary `generateObject` agent. Jev has
already decided and escalated the ambiguous cookie banner to a human while the
control is still generating. Produced by
[`06-jev-vs-control.ts`](examples/06-jev-vs-control.ts) with `npm run compare`;
read [what is and is not measured](#06-jev-vs-controlts--jev-against-a-control-model)
before drawing conclusions from the clock.

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
  shortlist handed to the caller:
    e1 "Accept all cookies" 46.0%
    e2 "Reject non-essential cookies" 31.4%
  HUMAN chose e2 "Reject non-essential cookies"

step 3  /pricing/pro
  target=none p=86.0% · confidence=55.5% · goalMet=96.0%
  DONE answer found on this page
```

The agent never resolves its own ambiguity. It stops, emits the shortlist, and
waits; a person picks. If nobody is available to pick, the run ends with status
`ambiguous` rather than proceeding on a 46% guess.

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

### [`05-browser-live.ts`](examples/05-browser-live.ts) — the same loop, against real Chrome

Example 04's argument, with the simulation removed. Chrome launches, the
elements come from the real DOM over CDP, the cursor moves to real coordinates
and the clicks are real input events. The decision policy is imported from
[`src/browser-policy.ts`](src/browser-policy.ts) and shared verbatim with
example 04; everything that is not the decision lives in
[`src/browser-driver.ts`](src/browser-driver.ts). Only the arm differs.

```bash
npm run record                 # writes docs/media/browser-use.mp4
npm run record -- --no-video   # drive the browser, skip encoding
```

It records itself with [`webreel`](https://www.npmjs.com/package/webreel), which
owns the cursor animation, the click overlay and the ffmpeg pipeline.

**Not zero-setup.** webreel downloads Chrome and ffmpeg into `~/.webreel` on
first run — a few hundred MB — which is why 05 and 06 are excluded from
`npm run all`.

### [`06-jev-vs-control.ts`](examples/06-jev-vs-control.ts) — Jev against a control model

The same task run twice through the same driver, recorded, and stitched
side by side.

| | Jev | Control |
|---|---|---|
| call | one `systemOne` | one `generateObject` |
| returns | a distribution over the elements, plus four scalars | one element id and a self-reported confidence |
| harness can gate on | the shape of the distribution | nothing trustworthy |
| the cookie banner | flat distribution → stops and asks | one answer → clicks it |

```bash
npm run compare                # writes docs/media/jev-vs-control.{mp4,gif}
npm run compare -- --no-video
```

The control is not a straw man. It gets the same page description and a strict
schema, which is how you are supposed to make a language model drive a UI. The
difference is structural: self-reported confidence is a token the model chose,
drawn from the same distribution as the rest of its output, and it is not a
measurement of anything. A harness handed one answer has nothing to check, so it
acts on every answer — which is what most agents in production actually do.

#### What the clock does and does not show

Read this before quoting the numbers.

- With **no keys** (the default), both arms replay scripted answers. Jev's
  decision time is ~0 because nothing leaves the process, and the control's is
  `CONTROL_THINK_MS` — a declared 2600 ms stand-in for a generation, not a
  measurement. The caption burned into each video says which mode it ran in.
- With **`TYPESAFE_API_KEY` and `AI_GATEWAY_API_KEY`** set, both arms make real
  calls and every number in the summary becomes a real measurement.
- The clicks, the DOM, the element enumeration and the escalation logic are real
  in both modes. **The recording is evidence that the loops behave as described.
  It is not a benchmark.**

The behavioural difference does not depend on the stand-in at all: it follows
from one arm returning a distribution and the other returning a single answer.

### [`examples/python/`](examples/python) — LangChain

LangChain's TypeSafe integration is **Python-only**; there is no
`@langchain/typesafe` on npm.

> **These two files have never been executed.** There was no Python environment
> and no API key in the build environment, so they are reference implementations
> read from the published `langchain-typesafe` API, not verified runs. Treat
> them as a starting point and expect to adjust.

They need `TYPESAFE_API_KEY`, and `langchain_harness.py` additionally needs a
generative provider (`OPENAI_API_KEY` as written). Neither runs offline.

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
npm run all                      # examples 01–04, in order

npm run record                   # 05: real Chrome, recorded
npm run compare                  # 06: Jev vs a control model, side by side
```

There is no build step. The examples are `.ts` files executed directly by
**Node ≥ 22.18**, which strips types natively. The dependencies are the real
published SDKs — `@typesafe-ai/sdk`, `ai`, `@ai-sdk/gateway` and `zod` — and
nothing in `src/` reimplements any of them.

`npm run all` deliberately stops at 04 so the repo keeps its clone-and-run
property. 05 and 06 add `webreel`, which downloads Chrome and ffmpeg into
`~/.webreel` on first use.

> **Known upstream issue.** webreel 0.1.4 requests an ffmpeg build
> (`ffmpeg-n7.1-…`) that its upstream no longer publishes, so the download 404s
> on a clean machine. Set `FFMPEG_PATH` to your own ffmpeg to work around it;
> the browser loop runs either way and only the video is lost. Separately, its
> headless launch flags (`--enable-begin-frame-control`) stall
> `Page.captureScreenshot` forever, so its own recorder captures zero frames —
> [`src/chrome-launch.ts`](src/chrome-launch.ts) starts the same binary without
> those two flags and explains why.

### Offline by default, live with one env var

Without a key, the examples inject a mock `fetch` into the real
`TypeSafeClient` ([`src/mock-fetch.ts`](src/mock-fetch.ts)) and a
`MockLanguageModelV4` from `ai/test` into the real `generateObject` call. The
SDKs' request building, retries and error handling all stay on the live code
path; only the HTTP response bodies are manufactured.

Note that the SDK does **not** runtime-validate responses — it parses JSON and
returns it. So the mock's fidelity is guaranteed by its TypeScript types and by
review, not by the SDK rejecting a wrong shape.

With a key, the exact same code calls the real services:

```bash
export TYPESAFE_API_KEY=...       # get one at typesafe.ai
export AI_GATEWAY_API_KEY=...     # only needed for example 03's proposer
node examples/01-quickstart.ts
```

`JEV_MOCK=1` forces the mocks even with keys. The SDK also honors
`TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL` and `TYPESAFE_LOG_LEVEL` — see
[`.env.example`](.env.example).

**Two honest caveats about the mock.**

It matches the response *declarations* published in `@typesafe-ai/sdk@0.5.7`
field for field, and it preserves the invariants that matter — distributions
sum to 1, a Score is the probability-weighted mean of its levels, a Choice is
the argmax. It has never been checked against a captured live response, so
"matches the published types" is the strongest claim available, not "matches
production".

It also approximates confidence as `1 - normalizedEntropy`. That makes
low-option-count questions look under-confident: a 83/17 split reports 34.2%,
and the 52/30/12/6 split in example 01 reports 18.9% — which is *why* that
example routes to triage instead of auto-routing. Real Jev calibrates
confidence differently, so read that particular outcome as a demonstration of
the threshold mechanism, not as a prediction of what Jev would decide. Do not
port the formula.

Score targets are also hit to within ~0.002 rather than exactly, because the
mock caps its peak mass at 0.999 and rounds the emitted distribution.

---

## Repo layout

```
src/client.ts         createClient() — real TypeSafeClient, mock fetch when offline
src/mock-fetch.ts     offline Fetch answering POST /v1/systemone
src/proposer.ts       the AI SDK half: generateObject + gateway, MockLanguageModelV4 offline
src/control-agent.ts  the control arm for example 06: generateObject browsing policy
src/rubric.ts         normalizeScore, weightedScore, gate, isAmbiguous, rankedOptions
src/browser-policy.ts the questions and the decision cascade, shared by 04/05/06
src/browser-driver.ts launch, record, describe, click — everything that is not the decision
src/chrome-launch.ts  Chrome that webreel's recorder can actually capture (see the note above)
src/compose.ts        side-by-side stacking and GIF export, on webreel's ffmpeg
src/ui.ts             console formatting
examples/             the six TypeScript examples, plus site/ and python/
docs/media/           recordings produced by examples 05 and 06
docs/SDKS.md          which SDK to use, and the naming trap between them
```

Everything in `src/` is either composition (`rubric.ts`, `browser-policy.ts`),
presentation (`ui.ts`), wiring (`client.ts`, `proposer.ts`, `control-agent.ts`),
plumbing over published packages (`browser-driver.ts`, `chrome-launch.ts`,
`compose.ts`) or an offline service simulator (`mock-fetch.ts`). There is no
hand-written API client: `@typesafe-ai/sdk` already does request building,
literal-typed answers, retry-with-jitter and typed errors, the AI SDK already
does structured generation and Gateway routing, and `webreel` already does CDP
recording, cursor overlays and encoding.

`mock-fetch.ts` is the one piece of genuinely hand-written protocol code, and
it exists only because no published package simulates Jev's `/v1/systemone`
responses. It is test infrastructure, not part of the live path.

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
