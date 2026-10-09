# What Jev is, and what it is not

This page explains the model the examples call and the pattern they share. It is
background for the examples, not a claim about how well Jev performs.

## What Jev is

Jev is TypeSafe AI's System One decision model. It is not a chat model. It does not
write text, and there is nothing to parse.

You hand it a **state** (a string, an object, a message list, whatever you already
have) and a map of **typed questions**. It returns typed answers with probability
distributions attached.

```ts
import { TypeSafeClient, choice, noul, score } from '@typesafe-ai/sdk';

const apiKey = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
if (!apiKey) throw new Error('Set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN');
const client = new TypeSafeClient({
  apiKey,
  baseURL: 'https://ai-gateway.vercel.sh/typesafe',
  defaultModel: 'typesafe-ai/jev',
});

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

Three primitives, and that is the whole question surface:

| Primitive  | Builder    | You get back                                           |
| ---------- | ---------- | ------------------------------------------------------ |
| **Choice** | `choice()` | `choice` + `probabilities` over your option keys        |
| **Score**  | `score()`  | `score` in `[0, levels-1]` + `probabilities` per level  |
| **Noul**   | `noul()`   | `noul`, a probability in `[0, 1]`                       |

`score()` takes an array of at least two labels, ordered lowest to highest.
`@typesafe-ai/sdk` 0.6.0 rejects the object form that 0.5.x accepted.

"Noul" is TypeSafe's term for a yes/no probability. The AI SDK calls it
`boolean` and `probability`. [`SDKS.md`](SDKS.md) has the full mapping, which is
where porting bugs come from.

Two properties drive the design:

1. **Questions are evaluated in parallel and in isolation.** Ten questions cost
   roughly what one costs in latency. Adding a question cannot degrade the answer
   to another one.
2. **Questions cannot read each other's answers.** If decision B depends on answer
   A, that is a second request, and usually it is a branch in your code instead.

Vercel's [model page for Jev](https://vercel.com/ai-gateway/models/jev) lists a
32,000-token context window, **$0.042 per 1M input tokens**, and a maximum output of
0 tokens. That was checked on 2026-10-08. An earlier version of this repository
described Jev as free on Vercel, as of 2026-09-22. That is no longer the listing.
Prices are not a guarantee about future pricing, account limits, other models or
infrastructure costs. Paid generative models are not enabled merely by providing
the Gateway credential used for Jev.

## What Jev is not

It is not an agent, a planner, a harness, or a tool router. TypeSafe's own position
is that **Jev is never the harness**. It is a decision point inside a loop your code
owns:

| Job                       | Owner               |
| ------------------------- | ------------------- |
| Interpret, propose        | a generative model  |
| **Judge, classify, gate** | **Jev**             |
| Decide whether to act     | **your code**       |
| Execute                   | your tool runner    |
| Update state              | **your code**       |
| Explain the result        | a generative model  |

Example 03 is built around that table.

The deterministic checks are intentional. Eligibility defines which actions may be
considered, binding ties arguments to records, and verification checks effects.
They do not replace Jev's semantic decision among eligible candidates. Its returned
distribution drives the choice, whether to gather evidence, and which probe is worth
trying next. Deterministic baselines remain useful comparisons. They are never
silently selected when a Jev key is missing.

## The shared pattern

Every example applies the same rule: **uncertainty selects the next machine action,
never a person.** When a distribution is flat, the application does one of three
things:

1. **Probe**: run a read-only action chosen to maximise expected information gain,
   observe the result, and re-judge.
2. **Act reversibly**: take an action it can verify and undo, then verify.
3. **Refuse**: stop, with a stated reason, having changed nothing.

The full rule and what each example may claim are in
[`CLAIM-CONTRACTS.md`](CLAIM-CONTRACTS.md).

## Six things worth internalizing

1. **Ask atomic questions.** "Is this a good response?" is three questions wearing a
   trench coat. Decompose, then combine in code.
2. **Ask them all at once.** Parallel and isolated means extra questions are nearly
   free in latency and cannot hurt each other's answers.
3. **Keep the distribution.** The argmax throws away the most useful thing you were
   given. A split distribution means *probe*, not *guess*. A point estimate cannot
   tell you which probe is worth running, because expected information gain over a
   point mass is zero for all of them.
4. **Confidence is concentration, not correctness.** It tells you the model was
   decisive. It does not tell you the model was right, and it is not permission to
   act.
5. **Gates are conditions, not weights.** Anything that must never happen gets its
   own check outside the average.
6. **Calibrate your thresholds.** The `0.7` and `0.75` in these examples are
   placeholders. Run labelled examples through your own rubric and pick real numbers.
