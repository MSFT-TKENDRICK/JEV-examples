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

Same maze, same driver, same click mechanics — only the decision model differs.
[`06-jev-vs-control.ts`](examples/06-jev-vs-control.ts) walks the fourteen-page
site twice: once keeping the distribution, once collapsing it to the argmax a
conventional `generateObject` agent would return. Run it with `npm run compare`;
it prints both arms and the divergence between them.

The difference is not that one arm is faster. It is that the arm which keeps the
distribution can rank an alternative, backtrack to it, and price a probe, and the
arm which keeps one answer can do none of those — expected information gain over
a point mass is exactly zero for every probe. Read
[what is and is not measured](#06--the-same-maze-twice)
before drawing conclusions from either arm.

06 is a terminal program and records nothing. The recorded example is
[`05-browser-live.ts`](examples/05-browser-live.ts), which drives a real browser
over the same site and writes
[`docs/media/browser-use.mp4`](docs/media/browser-use.mp4) with `webreel`.

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

<!-- fragment:01 -->

### 01 — Quickstart: one request, five questions, and what the answer does next

[`examples/01-quickstart.ts`](examples/01-quickstart.ts) — run with `npm run quickstart`.

Two habits, in order of importance.

**Ask everything in one call.** Questions are evaluated in parallel and in isolation
against the same state, so a fifth question costs almost no extra latency and cannot
pollute the other four with context rot. The example asks a `choice`, two `score`s and
two `noul`s about a support ticket in a single `systemOne` request.

**When the answer comes back flat, the flatness picks the next question.** The routing
distribution is treated as a prior. Two candidate follow-up questions are ranked by
expected entropy reduction per unit of cost, and the winner becomes a second request
whose *option set is built from the first distribution* — an answer that no remaining
contender predicts is never offered. The observation updates the prior, and then the
application routes or refuses. It does not ask a person.

Routing a ticket to a team is the task. What is ruled out is using a person as the
*answer to a flat distribution* — a triage queue, a shortlist for someone to pick from.
Those resolve nothing; they relocate it.

#### Ticket 1 — the probe changes the route

`billing` leads at 42.0% over `technical` at 40.0%. `sales` and `other` fall below the
15% contender floor, so the three-way follow-up is offered as a two-way one:

```
Choice — department: billing
  billing    ██████████··············  42.0%
  technical  ██████████··············  40.0%
  other      ███·····················  12.0%
  sales      █·······················   6.0%

The first answer chooses the second question
  contenders (>= 15.0%)  billing 42.0%   technical 40.0%
  blocking-symptom  What is actually blocking the customer right now?
    offered  charge_wrong, integration_failing
    ranked   blocking-symptom 0.693/cost 1   desired-remedy 0.495/cost 1.4
    entropy  0.693 nats → expected 0.000, actual 0.000
    observed integration_failing  leader billing 51.2% → technical 100.0%

Routing decision (plain code)
  route to   technical  leader holds 1.00 after 1 probe(s) costing 1
  → the probe changed the route: argmax was billing, routed to technical
  queue      urgent
  refund     auto-open refund case
```

The argmax answer was `billing`. One follow-up moved it to `technical`. Note that the
posterior is a point mass only because the authored partition says `charge_wrong` and
`integration_failing` separate those two departments cleanly — that sharpness is a
property of the fixture's partition, not evidence about the model.

#### Ticket 2 — the budget runs out and nothing happens

The second ticket is torn between `other` (42.0%) and `billing` (34.0%) — the first and
last options. This is why the fixture scripts an explicit distribution rather than a
target option: a peaked distribution decays with index distance and cannot express
confusion between two options that are not neighbours.

```
The first answer chooses the second question
  contenders (>= 15.0%)  other 42.0%   billing 34.0%   technical 16.0%
  blocking-symptom  What is actually blocking the customer right now?
    offered  charge_wrong, integration_failing, unclear
    ranked   blocking-symptom 0.755/cost 1   desired-remedy 0.736/cost 1.4
    entropy  1.030 nats → expected 0.275, actual 0.684
    observed integration_failing  leader other 45.7% → other 56.8%

Routing decision (plain code)
  route to   nothing — refused
  the best remaining probe (desired-remedy) costs 1.4 and only 0.5 of the 1.5 budget is left
```

Three contenders, so all three options are offered. The probe helps — 45.7% to 56.8% —
but not enough to clear the 70% bar, and the only remaining probe costs more than the
budget has left. The ticket is left exactly as it was found: not assigned, not queued,
not put in front of anyone to pick from. Terminal, with a stated reason.

Note also that the actual posterior entropy (0.684) is far above the expected (0.275).
The observation was less informative than its partition promised. The example prints
both rather than only the flattering one.

The probe costs and the answer/department partitions are authored; the arithmetic over
them is not. In both of these runs the probe that won on gain-per-cost also happened to
be the cheaper one — which on its own would leave open whether the selector is really
just sorting by price. [Example 02](docs/fragments/02.md) shows the converse, picking a 1.6-cost
sub-rubric over two 1.0-cost ones.

#### Claims

Everything runs offline against scripted fixtures in
[`src/mock-fetch.ts`](src/mock-fetch.ts), which manufacture HTTP responses on the
published SDK's real code path. No API key is needed and no network call is made.

**This example may claim:** that the application's second question is a function of the
first distribution; that expected-information-gain-per-cost selected between two
follow-ups, and that in both runs the winner on that measure also happened to be the
cheaper probe; that a probe moved the routing decision off the argmax answer; that
budget exhaustion produced a refusal which changed nothing. The arithmetic over the
fixture is real.

**It must not claim:** that the distribution deserves trust — the fixture is authored;
that the probe costs or the answer/department partitions are correct, since both are
authored too; that the sequence of probes is optimal, as selection is greedy
one-step-lookahead; that the entropy drop says anything about calibration.

See [`docs/CLAIM-CONTRACTS.md`](docs/CLAIM-CONTRACTS.md).

<!-- fragment:02 -->

### 02 — Model-as-a-judge: when the judge is torn, it decomposes

[`examples/02-judge-rubrics.ts`](examples/02-judge-rubrics.ts) — run with `npm run judge`.

Five candidate answers to the same support question are scored against three weighted
rubric dimensions and two hard safety gates. The part worth reading is what happens when
a verdict lands in the middle band.

A flat distribution on "is this answer good?" usually means the question is too coarse.
So the judge does not look for a person — it asks a **narrower question**. Each candidate
sub-rubric is a probe with a cost and an observation→verdict partition, and
[`selectProbe`](src/information-gain.ts) picks which one to spend a call on.

#### Different weightings, different rankings

The same five measurements, weighted two ways, do not agree:

```
Per-dimension, normalized to 0..1
  candidate   factual  complete  tone
  model-a        0.97      0.97  0.90
  model-b        0.73      0.07  0.10
  model-c        0.03      0.55  0.95
  model-d        0.45      0.95  0.75
  model-e        0.50      0.80  0.75

Why the weighting matters
  ranked by support-quality: model-a > model-d > model-e > model-b > model-c
  ranked by brand-voice:     model-a > model-d > model-e > model-c > model-b
```

`model-b` and `model-c` change places. `model-c` writes the warmest reply, outranks
`model-b` on brand-voice, and is the one that would cost you money — which is why the
safety check is a **gate**, checked separately and never weight-averaged:

```
Hard gates tripped (checked separately, never weight-averaged)
  ✗ model-c: invents policy (97.0%), claims an irreversible action (95.0%)
```

#### The verdict distribution is computed, not asserted

`factual` has four levels. Each level is pushed through that candidate's own composite
and thresholds, and the level probabilities accumulate onto the resulting verdict:

```
  candidate    pass  investigate    fail   leading band
  model-a      97.5%         1.7%    0.8%   PASS
  model-b       0.0%         0.0%  100.0%   fail (point mass)
  model-c       0.8%         1.7%   97.5%   FAIL
  model-d      38.8%        55.0%    6.3%   INVESTIGATE
  model-e       6.3%        40.0%   53.8%   FAIL
```

`model-b` is the interesting row: every level of `factual` lands in the same band,
because its other dimensions are weak enough that no factual score rescues it. The prior
is a point mass, so no sub-rubric could change the verdict and none is run. That is a
real and useful answer, and an argmax could not have supplied it.

#### Decomposition changes a verdict — and, elsewhere, refuses

`model-d` is torn. Three sub-rubrics are available; the one that wins costs **more** than
either alternative and is chosen anyway, because selection is on gain per unit cost:

```
  model-d
    exception-preserved  Do the conditions that gate the exception survive?
      ranked   exception-preserved 0.467/cost 1.6   window-stated 0.319/cost 1   step-authorised 0.319/cost 1
      entropy  0.869 nats → expected 0.122, actual 0.000
      observed conditions-dropped  leader investigate 55.0% → fail 100.0%
    FAIL  leader holds 1.00 after 1 probe(s) costing 1.6
      → decomposition changed the verdict: investigate → fail
```

This is the concrete evidence that EIG ranking is **not cheapest-first wearing a hat**.
`exception-preserved` costs 1.6 and still beats two 1.0-cost alternatives, 0.467 against
0.319, because it partitions the candidate verdicts better — it is the only sub-rubric
whose `conditions-kept` answer is consistent with `pass` alone. The selector paid 60%
more for the sharper question. Example 01's follow-up happened to be the cheaper probe in
both of its runs; this is the converse, and the two together are what rule out the
suspicion that the whole mechanism is an expensive way to sort by price.

`model-e` is the case the pattern must also handle. Every sub-rubric answer lands in its
middle level, the budget runs out, and the judge certifies nothing:

```
  model-e
    window-stated  Is the headline refund window itself stated correctly?
      ranked   window-stated 0.410/cost 1   step-authorised 0.410/cost 1   exception-preserved 0.264/cost 1.6
      entropy  0.873 nats → expected 0.464, actual 0.682
      observed window-implied  leader fail 53.8% → fail 57.3%
    step-authorised  Is the next step it names one the policy actually authorises?
      ranked   step-authorised 0.341/cost 1   exception-preserved 0.126/cost 1.6
      entropy  0.682 nats → expected 0.341, actual 0.682
      observed step-absent  leader fail 57.3% → fail 57.3%
    NOT CERTIFIED  probe budget of 2 is spent and the leader still holds only 0.57
```

Nothing is recorded against the candidate, nothing is queued, and no one is asked. The
judge does not know, and stopping is the honest move. Note that the second probe's actual
posterior entropy (0.682) is identical to its prior — that probe bought nothing at all,
and the example prints it rather than hiding it.

A tripped hard gate is not ambiguity, so `model-c` is never decomposed: "not a question of
degree, so nothing to decompose".

#### Why an argmax judge cannot do this

Collapse `model-d`'s prior to its leading band and re-run the same selection:

```
  distribution-backed prior  pass 38.8%   investigate 55.0%   fail 6.3%
  argmax-collapsed prior     pass 0.0%   investigate 100.0%   fail 0.0%

  eigIsDegenerate(argmax-collapsed) = true
  selectProbe → chosen none, 0 probe(s) ranked
```

This is arithmetic, not rhetoric. A distribution with all mass on one verdict has zero
entropy, and its posterior under any observation is that same point mass, so every probe
scores EIG = 0 − 0 = 0 exactly. Not "low" — equal, and equal to zero. There is no basis on
which to prefer one narrower question over another.

The claim is narrow: that is what a bare point estimate supplies. It is **not** a claim
that a generative system cannot probe. One can be built to — just not from this input.

#### Claims

Everything runs offline against scripted fixtures in
[`src/mock-fetch.ts`](src/mock-fetch.ts), which manufacture HTTP responses on the
published SDK's real code path. No API key is needed and no network call is made.

**This example may claim:** that two weightings of the same measurements produce different
rankings; that hard gates catch what no weighting would; that the verdict distribution is
computed from the returned level probabilities rather than authored; that a decomposition
chosen by expected gain per unit cost changed a verdict from `investigate` to `fail`; that
a spent budget produced a refusal to certify; that an argmax-collapsed prior is degenerate
and yields no probe ranking at all.

**It must not claim:** that the level probabilities deserve trust — the fixture is
authored; that the sub-rubric costs or the observation→verdict partitions are correct,
since those are authored too; that the probe sequence is optimal, as selection is greedy
one-step-lookahead; that entropy reduction indicates calibration; that judging without a
human is safer than judging with one.

See [`docs/CLAIM-CONTRACTS.md`](docs/CLAIM-CONTRACTS.md).

<!-- fragment:03 -->

### 03 — Agent harness: uncertainty selects the next machine action

[`examples/03-agent-harness.ts`](examples/03-agent-harness.ts)

```bash
npm run harness
```

Runs offline with no API key. Every distribution below is manufactured by
`src/mock-fetch.ts` and replayed through the real `@typesafe-ai/sdk` code path;
the generative triage arm is `generateObject` against `MockLanguageModelV4` from
`ai/test`. The entropy and expected-gain arithmetic over those distributions is
real. The probe set, the probe costs and the partitions are authored in
`src/tools/probes.ts`.

**What this may be read as showing:** what an application does with a
distribution — when it probes, when it commits, when it refuses, and how it
orders an irreversible step against reversible ones.

**What it must not be read as showing:** that the distribution deserves trust.
No domain validation has been performed, the thresholds are illustrative rather
than empirically selected, and no accuracy claim is made or supported.

#### The problem: co-applicable tools

Five tools could each plausibly apply to a stalled warehouse export. They are
not mutually exclusive, and two of them are irreversible:

| tool | argument | irreversible step |
|---|---|---|
| `rotate_export_credential` | credential | yes — revoke the old secret |
| `replay_export_window` | export run | no |
| `resize_worker_pool` | worker pool | no |
| `drop_poison_message` | queue message | yes — drop the head message |
| `reissue_warehouse_grant` | grant role | no |

A point estimate over these is not wrong so much as unusable: it cannot express
*torn between rotation and a poison message*, which is the state the harness is
actually in before it reads anything.

#### A flat distribution buys a read-only probe, not a coin flip

The first judgement is close to uniform. Instead of committing to the 30% leader
or asking a person, the harness ranks the five probes by expected information
gain per unit cost and runs the winner:

```text
  round 0 · no observations yet
    replay_export_window      ███████·················  30.0%
    rotate_export_credential  ██████··················  24.0%
    reissue_warehouse_grant   ████····················  18.0%
    resize_worker_pool        ███·····················  14.0%
    drop_poison_message       ██······················  10.0%
    none_of_these             █·······················   4.0%
    leader replay_export_window at 30.0% · entropy 1.647 nats (92% of uniform) · evidence_sufficient 21.0%

  round 1 · budget 5 of 5 left
      scheduler_status       cost 1  EIG 0.741 nats  per cost 0.741
      credential_expiry      cost 1  EIG 0.545 nats  per cost 0.545
      queue_depth            cost 2  EIG 0.718 nats  per cost 0.359
      warehouse_grant_dryrun cost 3  EIG 0.658 nats  per cost 0.219
      worker_pool_health     cost 2  EIG 0.412 nats  per cost 0.206
    PROBE scheduler_status (read the export schedule and the status of its last runs)
      observed runs_failing · cost 1 · expected to remove 0.741 of 1.647 nats
```

The probe **changes which tool wins**. Nothing was executed to learn it:

```text
    re-judged with the observation in state
    rotate_export_credential  █████████···············  37.0%
    drop_poison_message       ██████··················  27.0%
    reissue_warehouse_grant   ██████··················  25.0%
    replay_export_window      ██······················   7.0%
    leader rotate_export_credential at 37.0% · entropy 1.411 nats (79% of uniform)
    FLIP leader moved replay_export_window -> rotate_export_credential — the probe changed the answer, and nothing was executed to learn it
```

A second cost-1 probe concentrates the mass to 86%, past the 0.72 decision
threshold, and the harness commits.

#### The degenerate comparison: why a point estimate has nothing to probe on

Run the same probe assessment against a point-estimate prior — the shape a
single-answer tool picker produces — and every probe is worth exactly nothing:

```text
  point-estimate arm "replay_export_window" with no distribution: eigIsDegenerate=true · best EIG over 5 probes = 0.000 nats
    scheduler_status       H(prior) 0.000  E[H(posterior)] 0.000  EIG 0.000
    credential_expiry      H(prior) 0.000  E[H(posterior)] 0.000  EIG 0.000
    worker_pool_health     H(prior) 0.000  E[H(posterior)] 0.000  EIG 0.000
    queue_depth            H(prior) 0.000  E[H(posterior)] 0.000  EIG 0.000
    warehouse_grant_dryrun H(prior) 0.000  E[H(posterior)] 0.000  EIG 0.000
```

A point mass has zero entropy, and its posterior under any observation is that
same point mass, so the subtraction is `0 - 0` for all five. An argmax-only
interface does not make choosing what to check first *harder* — it makes every
check look identically worthless, which removes any principled basis for
choosing one. That is the whole argument for carrying the distribution.

#### Commit: the irreversible step runs last, by construction

Once concentrated, the chosen action expands into a multi-step plan and runs
through `runPlan` from `src/compensate.ts`, which rejects any plan with more
than one irreversible step or with any step after it:

```text
  COMMIT rotate_export_credential at 86.0% — stage a new warehouse credential, repoint the job, revoke the old secret
  bind credential for rotate_export_credential · 1 candidate record(s) in export-control-plane@v3
    BOUND credential=cred-wh-2025-11 from export-control-plane@v3

  plan  stage_credential -> repoint_export_job -> revoke_old_credential (irreversible)
    ok               stage_credential       cred-wh-2025-11-rotated authenticates against the warehouse
    ok               repoint_export_job     job configuration reads cred-wh-2025-11-rotated
    ok               revoke_old_credential  cred-wh-2025-11 no longer authenticates
  COMPLETED all steps acted and verified
```

#### A reversible step fails verification, and the plan rolls back in reverse

`reissue_warehouse_grant` acts, verifies, then replays a window that lands zero
rows. Verification fails and the completed steps are compensated backwards:

```text
  plan  reissue_grant -> rebuild_manifest -> replay_window
    ok               reissue_grant          warehouse_writer reads as granted
    ok               rebuild_manifest       manifest timestamped 2026-03-11T02:58:00.000Z
    failed           replay_window          run-2026-03-10-nightly replayed but landed 0 rows — the window is still empty
    compensated, in reverse order:
      undo replay_window
      undo rebuild_manifest
      undo reissue_grant
  ROLLED_BACK step "replay_window" failed verification
```

Reverse order is not cosmetic: the later steps were built on the earlier ones,
so undoing the grant before undoing the replay would leave the replay
referencing a permission that no longer exists. The world ends where it started
and the incident is unresolved — worse than success, much better than a
half-applied change.

#### Budget exhausted: refuse, and change nothing

On a second incident the distribution stays flat, the two cheap probes are spent
and the only probe that would still discriminate costs more than the budget has
left:

```text
  round 3 · budget 1 of 3 left
    x queue_depth            cost 2  EIG 0.859 nats  per cost 0.429
    x warehouse_grant_dryrun cost 3  EIG 0.661 nats  per cost 0.220
    x worker_pool_health     cost 2  EIG 0.246 nats  per cost 0.123
    BUDGET probe budget exhausted: 2 of 3 spent, and the cheapest probe still worth running (queue_depth, cost 2) costs more than the 1 remaining

  REFUSE leader holds 40.0%, below the 0.72 threshold; evidence_sufficient 38.0% below 0.5
```

This is a terminal state of the program. Nothing was executed, no state changed,
and no work item was created for anyone. Raising the budget would let it keep
probing; whether that is the right policy is a question about this incident
class, not about the mechanism.

#### Arguments are bound separately, against the system of record

Tool arguments are chosen in a second, step-specific judgement — independently
selected marginals do not compose into a coherent joint call — and then resolved
against the authoritative snapshot. A well-formed identifier scraped out of the
customer's ticket by the generative arm does not resolve, so nothing runs:

```text
  record id lifted from the ticket: run-2026-03-09-nightly
  ...
  bind export_run for replay_export_window · 0 candidate record(s) in export-control-plane@v3
    REJECTED run-2026-03-09-nightly (from the ticket)
      export-control-plane@v3 holds no export run this tool could act on
  REFUSE no export_run in export-control-plane@v3 for this action
```

The rejection is `bindArgument` in application code, not model self-restraint. A
generative implementation constrained to enumerated identifiers would pass the
same check for the same reason.

#### Against cheapest-first

The run reports, **per round only**, where a cheapest-probe-first policy would
have chosen differently:

```text
  denied-grant       round 3  worker_pool_health -> queue_depth  1.00x cost for 3.88x expected information
  1 of 8 probe rounds diverged.
```

It is never accumulated into a running total, and the output says why: had
cheapest-first actually run its probe, it would have observed something else,
producing a different posterior and a different option set next round. Only the
first divergent step is knowable from a trail that policy never generated.
Probing is path-dependent, which is why selecting probes is a sequential problem
and not a sort.

Two honesty notes carried in the output itself. Ranking is by gain per cost, so
the chosen probe beating the cheapest one *on gain per cost* is true by
construction — a consistency check, not a result. And in these four fixtures no
divergent round paid more for less information, which is a property of the
authored costs rather than a finding.

#### Outcomes

```text
  incident           leading action             probes spend  outcome
  stale-credentials  rotate_export_credential   2      2      completed
  wedged-queue       drop_poison_message        2      2      refused
  denied-grant       reissue_warehouse_grant    3      4      rolled_back
  phantom-run-id     replay_export_window       1      1      refused
```

Two of the four executed nothing at all. None of the four asked a person.

<!-- fragment:04 -->

### 04 — Browser use: pick an element, never invent one

[`examples/04-browser-use.ts`](examples/04-browser-use.ts) — a long-horizon
navigation task across a fourteen-page synthetic account portal, where the
candidate set on every page is the page's own elements and uncertainty selects
the next *machine* action rather than a person.

```bash
node examples/04-browser-use.ts
```

**This is a scripted offline fixture.** No live TypeSafe API call is made. Every
distribution is predetermined in the example's script and replayed through
[`src/mock-fetch.ts`](src/mock-fetch.ts), so the real SDK code path runs
against manufactured HTTP responses. The site, the confusable labels, the probe
costs and the depth of the trap were all authored here — which means the
difficulty was authored too. The run demonstrates what the application does with
a distribution. It does not demonstrate that the distribution deserves trust.

#### What it may be read as showing

Options are the page's own elements, enumerated by the DOM before the model is
asked; `none` is always available; a flat distribution triggers a read-only probe
chosen by expected information gain per unit cost rather than a request for human
input; a proven dead end causes the run to resume from a ranked alternative; the
one irreversible step runs last, behind a preflight, after two reversible verified
steps; and exhausting the probe budget without discrimination ends the run
terminally, having changed nothing.

**What it must not be read as showing:** that Jev navigates websites well, that it
is calibrated for element selection, that the probabilities are meaningful
estimates of anything, that a maze authored to be hard is evidence the model found
it hard, or that beam search plus EIG makes an agent safe. The binding list is
[`docs/CLAIM-CONTRACTS.md`](docs/CLAIM-CONTRACTS.md).

#### Uncertainty selects an action, not a person

Three routes exist when the distribution will not resolve, and none of them is a
handoff:

1. **Probe** — a read-only peek at evidence already in the page (a breadcrumb, a
   badge count, a disabled state, a footer legend), selected by
   [`selectProbe`](src/information-gain.ts), then re-judge.
2. **Act reversibly** — click something verifiable and undoable, then verify.
3. **Refuse** — stop, state why, change nothing. Terminal.

There is no `escalate`, no `approval_required`, no queue. `Status` is
`goal_reached | refused | probes_exhausted | no_path | max_steps`.

#### Scenario A — the confident click is wrong

The highest-mass link on the landing page is "Account documents" at 0.62. It is
wrong, and it takes three pages to prove it:

```
  step 4  archive-2025.html  1 candidate · ~133 tokens of page state
    Statement archive, 2025. This archive holds account statements only. VAT invoices and other tax docu
    belief  none 0.89  e1 0.11
    goalMet 1.0% · atTarget 2.0% · deadEnd 94.0%
    dead end the archive states outright that it holds statements only and that tax documents moved to Billing in 2024 - the branch is proven, not guessed, to be finished
    resume  "Billing history" path probability 0.1313
             this page rules the route out explicitly - resuming from the best surviving alternative, which exists because the branch point was ranked rather than resolved
```

**The alternative it backs up to is exactly the probability mass it declined to
throw away at the branch point.** "Billing history" carried 0.13 on the landing
page. An interface that returns one answer never produced that number, so there is
nothing to return to: the beam is one wide, and the first dead end is the last
page. [`src/frontier.ts`](src/frontier.ts) is a probability-weighted beam
search precisely because the beam has to be weighted by *something*.

The run ends:

```
  outcome goal_reached  8 pages · 8 Jev requests · 2 probes costing 3 of 8 · 1 backtrack(s)
  frontier 2 open, 1 dead, 3 pruned holding 0.1515 of path mass, beam width 3
```

#### Scenario B — probing changes the answer

A different account renders different metadata, and the leading label is the wrong
one. Two peeks, chosen by gain per unit cost, move the mass onto a different link
before any page is loaded:

```
    belief  e6 0.37  e5 0.29  none 0.13  e1 0.09  e2 0.05  e3 0.04  e4 0.03
    probe   badge-counts cost 1, EIG 0.652
             considered gain/cost badge-counts 0.652/1, breadcrumb 1.172/2, disabled-state 0.333/1, footer-legend 0.553/3
             saw "billing" -> e6 0.56  e5 0.44
    probe   breadcrumb cost 2, EIG 0.686
             considered gain/cost breadcrumb 0.686/2, disabled-state 0.000/1, footer-legend 0.000/3
             saw "billing/charges" -> e5 1.00
    click   "Billing history" 100.0% -> billing
```

The probe changed the decision. It was not reported alongside a decision already
taken. Note the second line of the second probe: once `badge-counts` has been
seen, `disabled-state` and `footer-legend` are worth **0.000** — they no longer
discriminate between the two surviving candidates. That is the ranking doing
work, not decoration.

#### Scenario C — the refusal

A third account renders none of the metadata the peeks read, so every observation
comes back `unknown` and [`posterior`](src/information-gain.ts) falls back
to the prior:

```
    probe   footer-legend cost 3, EIG 0.553
             saw "unknown" -> e6 0.43  e5 0.33  e1 0.10  e2 0.06  e3 0.05  e4 0.03
    refuse  probes_exhausted
             the distribution is flat (leader e6 at 0.43) and no probes left to run. Stopping without acting, having changed nothing.
```

Terminal. Not a queue, not an approval, not a person.

#### The irreversible step

The re-issue form is submitted through
[`src/compensate.ts`](src/compensate.ts), which rejects any plan whose
irreversible step is not last before anything runs:

```
    commit  "Submit re-issue request" 95.9%
             set-period: period reads back as 2025-09
             set-delivery: delivery address reads back as the account owner
             submit: provider returned REQ-88213
             plan outcome: completed
```

Both reversible steps verify by reading the value back. The commit gate requires
`atTarget ≥ 0.8` *and* a leader above 0.9; until then the irreversible elements
are excluded from the navigation view of the distribution entirely, so "Dispute
this charge" is never a candidate for a click.

<!-- fragment:05 -->

### 05 — The same loop, against a real browser

[`examples/05-browser-live.ts`](examples/05-browser-live.ts) — the decision
loop from example 04, unchanged, driving real Chrome over CDP against the same
fourteen-page site rendered to disk, recorded with
[`webreel`](https://www.npmjs.com/package/webreel).

```bash
node examples/05-browser-live.ts             # record to docs/media/browser-use.mp4
node examples/05-browser-live.ts --no-video  # drive the browser, skip the recording
```

**The judgement is still a scripted offline fixture unless `TYPESAFE_API_KEY` is
set.** With a key it makes live calls; without one it replays the same script
example 04 uses, through [`src/mock-fetch.ts`](src/mock-fetch.ts). What is
real either way is the browser: real page loads from `examples/site`, the cursor
moving to the element the policy chose, real typing into the re-issue form, and
values read back out of the DOM to verify. The site was authored to be hard, so
the video is evidence of what the application does with a distribution — not
evidence that the distribution deserves trust.

#### What it may be read as showing

That the loop in [`src/site/walk.ts`](src/site/walk.ts) is literally the
same code offline and against a browser — the only difference is a `WalkDriver`;
that the candidate set comes from the live DOM rather than from the fixture; that
a backtrack is performed by returning to the entry page and re-clicking the path,
not by teleporting to a URL; and that the reversible steps of the irreversible
plan verify against the real DOM.

**What it must not be read as showing:** anything about Jev's accuracy, about
browser agents in general, or about the difficulty of a site whose difficulty was
authored in this repository.

#### The DOM is checked against the graph

Every arrival compares the live element list and the filename against
[`src/site/graph.ts`](src/site/graph.ts) and **throws on mismatch**, so the
live example cannot silently degrade into the offline fixture:

```
  step 2  documents.html
    dom     3 elements match the graph
    belief  e2 0.64  e1 0.28  none 0.05  e3 0.03
    click   "Tax documents" 69.6%
```

This check earned its place immediately. The first run of the rewritten site
failed with `The rendered page archive.html does not match graph page documents`,
which was a genuine bug: webreel's `clickAt` fires a native CDP click *and* a JS
synthetic click at the same coordinates, so the native click navigated and the
synthetic one then clicked whatever occupied those coordinates on the page that
had just loaded — two pages per click. The driver now moves the cursor for the
recording and follows the element's own `href`.

#### Real output from a real run

```
  step 4  archive-2025.html
    dom     1 elements match the graph
    belief  none 0.89  e1 0.11
    dead end the archive states outright that it holds statements only and that tax documents moved to Billing in 2024 - the branch is proven, not guessed, to be finished
    resume  replaying to "billing" path probability 0.1313

  step 5  billing.html
    dom     4 elements match the graph
    belief  e2 0.36  e3 0.32  e1 0.30  e4 0.01  none 0.01
    probe   charge-amount cost 1, EIG 0.632, page returned "subscription-amount"
    probe   period-marker cost 2, EIG 0.689, page returned "september"
    click   "September 2025" 100.0%
```

The peeks read evidence that is genuinely in the DOM — a `data-peek` index built
by [`src/site/render.ts`](src/site/render.ts) over badges, `title`
breadcrumbs, `data-enabled` attributes and the footer legend. It is a convenience
for reading them cheaply, not a capability claim.

The commit, with the form filled and read back through CDP:

```
  step 7  reissue.html
    dom     4 elements match the graph
    belief  e3 0.94  e1 0.02  e2 0.02  none 0.02
    commit  "Submit re-issue request" 95.9%
             period reads back as 2025-09
             delivery address reads back as the account owner
             provider returned REQ-88213

  step 8  submitted.html
    dom     1 elements match the graph
    belief  none 0.94  e1 0.06
    done    the page confirms the task was carried out

  outcome goal_reached  8 pages · 8 requests · 2 probes costing 3 · 1 backtrack(s) · 28892ms wall clock
```

#### The recording

The run above writes `docs/media/browser-use.mp4`. If webreel cannot obtain
`ffmpeg` the example says so and keeps going — you lose the video, not the result:

```
  No video was written. The run above still happened in a real browser; only the
  recording is missing. webreel downloads ffmpeg on first use and that fetch can fail -
  set FFMPEG_PATH to an existing binary and run again.
```

Recording is set to 20 fps rather than webreel's default 60, because the recorder
caps duplicate frames at three and a mostly-static page therefore plays back fast
at 60.

<!-- fragment:06 -->

### 06 — The same maze, twice

[`examples/06-jev-vs-control.ts`](examples/06-jev-vs-control.ts) — the same
fourteen-page maze, the same decision loop, the same judgements, walked twice:
once by an arm that keeps the whole distribution, once by an arm that keeps one
answer.

```bash
node examples/06-jev-vs-control.ts
```

**This is a scripted offline fixture, and the control arm is an adversarial
fixture rather than a fair benchmark.** Its replies are replayed, not generated,
and they were written here. A competent generative implementation constrained the
same way could pass the same checks. The claim being made is narrow and is about
*what a bare point estimate supplies to an application*, not about which model is
better.

#### What it may be read as showing

That two capabilities the application uses are arithmetic consequences of holding
a distribution, and are unavailable without one: ranking an alternative to resume
from, and pricing a probe. Both are checkable against the numbers the example
prints.

**What it must not be read as showing:** that Jev beats any particular model, that
the control arm is what a well-built generative agent looks like, that the outcome
gap measures capability, or that a maze authored in this repository measures
anything about real websites.

#### The outcome

```
  jev       distribution over page elements, beam width 3
    path    click "Account documents" -> click "Tax documents" -> click "2025 documents" -> backtrack to "Billing history" -> click "September 2025" -> click "Request re-issue" -> submit "Submit re-issue request"
    cost    8 pages · 8 requests · 2 probes costing 3 · 1 backtrack(s)
    frontier beam 3 · 2 open · 1 dead · 3 pruned holding 0.1515 of path mass
    outcome goal_reached

  control   openai/gpt-5.6-terra replayed, one id per page, beam width 1
    path    click "Account documents" -> click "Tax documents" -> click "2025 documents"
    cost    4 pages · 4 requests · 0 probes costing 0 · 0 backtrack(s)
    frontier beam 1 · 1 open · 0 dead · 0 pruned holding 0.0000 of path mass
    outcome no_path
```

#### The failure is attributable, not merely worse

The control arm is deliberately given a good schema. It has `atTarget` and
`deadEnd` fields, and it uses them correctly:

```
what the control arm lacked
  1. Something to back up to. Both arms clicked "Account documents" first. Three pages
     later the archive proves the branch finished, and - importantly - the control arm knew it:
     its schema has a `deadEnd` field and it set it. It asked to back up. There was nowhere to
     back up to, so no_path was the only answer available.

     The alternatives you back up to are exactly the probability mass you threw away at the
     branch point. Here that is 0.1313 of path probability, sitting on "Billing history",
     which is the link that works.
```

It recognised the dead end. It asked to back up. The capability it lacked is named
exactly: a ranked alternative. A beam search needs a distribution to weight the
beam, so with a point estimate `k = 1` always, and
[`frontier.best()`](src/frontier.ts) returns `null` the first time the only
live path dies.

#### Probe selection does not get harder — it gets worthless

```
       H(distribution) = 1.2279 bits      H(point estimate) = 0.0000 bits
       eigIsDegenerate(distribution) = false   eigIsDegenerate(point estimate) = true

     charge-amount    distribution 0.2921   point estimate 0.0000
     period-marker    distribution 0.3718   point estimate 0.0000
     badge-counts     distribution 0.6885   point estimate 0.0000
     disabled-state   distribution 0.3488   point estimate 0.0000
     breadcrumb       distribution 0.8388   point estimate 0.0000
     footer-legend    distribution 0.5297   point estimate 0.0000
```

Expected information gain is the entropy a probe is expected to remove. `H(P) = 0`
for a point mass, and the posterior of a point mass is that same point mass, so
EIG is **exactly zero for every probe** — not small, not noisy, zero.
`selectProbe` has nothing to rank, and an agent built on it proceeds on the answer
it already had, with extra machinery attached.

#### The honest reading

Quoted from the run itself:

```
the honest reading
  This is a scripted fixture over a site written for the purpose. The labels are confusable
  because they were written to be, the trap is three pages deep because it was built three
  pages deep, and the probe costs are authored numbers. Nothing here measures whether Jev
  judges this site well.

  What it does show is mechanical and checkable: given the same judgements, the application
  that keeps the distribution can rank an alternative and price a probe, and the application
  that keeps only the argmax can do neither. Both facts are arithmetic on the numbers printed
  above. A generative model that emitted calibrated scores over the same candidate list would
  drive the same machinery just as well - the deficiency is in the single answer, not in the
  kind of model that produced it.
```

The binding list of permitted claims is
[`docs/CLAIM-CONTRACTS.md`](docs/CLAIM-CONTRACTS.md).

<!-- fragments:end -->

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

## FSI examples

Four of the examples above are about Jev's mechanics. These two are about a
domain: what a bounded-choice model is worth inside a regulated financial
services workflow, where the cost of a confident wrong answer is not a bad
paragraph but a wrongly frozen card or a wrongly touched production system.

Both are written to a stricter standard than examples 01–06, recorded in
[`docs/CLAIM-CONTRACTS.md`](docs/CLAIM-CONTRACTS.md) and
[`docs/FSI-BOUNDARIES.md`](docs/FSI-BOUNDARIES.md): every decision is written to
a JSONL ledger, every run is labelled as scripted, and no example is permitted
to claim a distribution deserves trust — only to show what the surrounding
application does with one.

```bash
npm run fsi:07
npm run fsi:08
npm run fsi:eval
```

<!-- fragment:07 -->

### 07 — Uncertainty selects the next machine action

`npm run fsi:07`

A card-servicing workflow. Deterministic code reads the records, computes which
steps are even eligible, and only then asks Jev which eligible step comes next.

The interesting part is what happens when the answer is flat. The application
does not ask anyone. It works out which read would best separate the leading
candidates, performs exactly that read, and judges again with the observation in
the state. Three outcomes are possible and none of them is a person:

- **probe** — a read-only lookup chosen by expected information gain per unit
  cost, then re-judge;
- **act** — expand the step into an act/verify/compensate plan in which every
  reversible step is verified before the single irreversible step commits;
- **refuse** — stop, state why, change nothing. Terminal.

#### A probe changes which step wins

The customer is unsure whether they signed up for something. The first
distribution leads on "send them the receipt", by five points over "open a
dispute" — not enough to act on:

```
  jev recommends send_transaction_receipt
    send_transaction_receipt  ██████████··············  41.0%
    open_dispute              █████████···············  36.0%
    freeze_card               ███·····················  13.0%
    schedule_callback         █·······················   5.0%
    record_customer_note      █·······················   3.0%
    none_of_these             ························   2.0%
    p=41.0% · margin=0.05 · entropy=0.74 · over 6 offered options
    selected probability 0.41 < 0.70; margin 0.05 < 0.25; entropy 0.74 > 0.60
  PROBE ambiguous (selected probability 0.41 < 0.70; margin 0.05 < 0.25; entropy 0.74 > 0.60); buying evidence rather than guessing

  probe 1 of 2 · ranked by expected gain per unit cost
    probe                 cost    E[gain]  gain/cost
  → device_fingerprint       2    0.7066     0.3533
    merchant_mandate         2    0.6793     0.3396
    card_status              1    0.2225     0.2225
    transaction_history      3    0.6434     0.2145
    velocity_check           4    0.6793     0.1698
    prior_dispute_record     6    0.6793     0.1132
    read device_fingerprint (the device signal service) → unrecognised_device
      the charge was presented by a device never seen on this account
      entropy 1.3318 → 0.6420 nats
  re-judging with the observation in the state

  jev recommends open_dispute
    open_dispute              ████████████████████····  82.0%
    freeze_card               ██······················   9.0%
    send_transaction_receipt  █·······················   5.0%
    schedule_callback         ························   2.0%
    record_customer_note      ························   1.0%
    none_of_these             ························   1.0%
    p=82.0% · margin=0.73 · entropy=0.39 · over 6 offered options
    passes all three tests
  ACT all distribution tests passed over 6 offered options
```

The leader before the lookup is not the leader after it. Note also that the
cheapest probe did not win and the highest-gain probes did not win on gain
alone: `card_status` costs 1 but only removes 0.22 nats, while
`prior_dispute_record` removes 0.68 nats for a cost of 6. The whole ranking is
printed because a selection you cannot see lose to anything is not a selection.

#### The budget runs out and the application refuses

Two lookups later, on a genuinely unresolvable report, the distribution has
barely moved:

```
  probe 2 of 2 · ranked by expected gain per unit cost
    probe                 cost    E[gain]  gain/cost
  → merchant_mandate         2    0.6664     0.3332
    card_status              1    0.2143     0.2143
    transaction_history      3    0.5399     0.1800
    velocity_check           4    0.6664     0.1666
    prior_dispute_record     6    0.6664     0.1111
    read merchant_mandate (the standing-instruction register) → no_mandate
      no standing instruction with Zephyr Digital on this account
      entropy 1.5454 → 0.7027 nats
  re-judging with the observation in the state
  ...
  REFUSE still ambiguous after 2 probe(s), which exhausts the budget of 2: selected probability 0.32 < 0.70; margin 0.02 < 0.25; entropy 0.85 > 0.60. Nothing was changed.
  Nothing was changed and nothing was handed anywhere. This is where the run ends
  for this case: a refusal is a terminal state of the program, not a destination.
```

A probe already spent is excluded from the next ranking — reading the same
record twice buys nothing the second time, which is why `device_fingerprint` is
absent from the round-two table.

#### A failed verification unwinds the plan in reverse

`open_dispute` is not one action. It expands into a plan whose one irreversible
step is last, checked by `validatePlan` before anything runs. When the
provisional credit hold does not verify, the chargeback is never presented:

```
  plan 3 step(s) · digest sha256:386db7678c60e759
    1. record_dispute_intent  reversible
       note the intended dispute on the case
    2. place_provisional_credit_hold  reversible
       hold 249.99 GBP provisionally
    3. present_chargeback_to_scheme  irreversible
       present the chargeback — the point of no return
  ROLLED BACK step "place_provisional_credit_hold" failed verification
    ✓ record_dispute_intent intent for TXN-70455 is on the case file
    ! place_provisional_credit_hold the downstream service did not confirm the write (fixture)
    compensating in reverse plan order:
      ↩ place_provisional_credit_hold undone
      ↩ record_dispute_intent undone
```

#### Eleven decisions, five of which changed nothing

```
  scenario                         jev recommended         route    probes                               harness executed        outcome      baseline
  probe-changes-the-answer         open_dispute            act      device_fingerprint                   open_dispute            completed    freeze_card
  budget-exhausted                 open_dispute            refused  device_fingerprint+merchant_mandate  no_action_taken         refused      freeze_card
  rollback-on-failed-verification  open_dispute            act      —                                    no_action_taken         rolled_back  open_dispute
  already-frozen                   open_dispute            act      —                                    open_dispute            completed    open_dispute
  records-changed-before-commit    open_dispute            act      —                                    no_action_taken         refused      freeze_card
  unbound-arguments                open_dispute            act      —                                    open_dispute            completed    freeze_card
  service-unavailable              (none)                  refused  —                                    no_action_taken         refused      freeze_card
  full-servicing-run#1             freeze_card             act      —                                    freeze_card             completed    freeze_card
  full-servicing-run#2             order_replacement_card  act      card_status                          order_replacement_card  completed    open_dispute
  full-servicing-run#3             open_dispute            act      —                                    open_dispute            completed    open_dispute
  full-servicing-run#4             close_case              act      —                                    close_case              completed    send_transaction_receipt
```

`full-servicing-run` is one case across four rounds. Each executed step changes
the records, so the eligible set and therefore the question differ every round:
freezing the card is what makes a replacement eligible at all, and the case can
only close once no disputable transaction is outstanding and the acting
principal is entitled to close it.

#### A point estimate gives a probe nothing to remove

The same six probes, assessed by the same kernel, against a contested prior and
then against a point estimate:

```
  contested prior H=1.2982 nats
    card_status           prior H=1.2982  E[posterior H]=1.0751  E[gain]=0.2231
    device_fingerprint    prior H=1.2982  E[posterior H]=0.6052  E[gain]=0.6929
    merchant_mandate      prior H=1.2982  E[posterior H]=0.6052  E[gain]=0.6929
    transaction_history   prior H=1.2982  E[posterior H]=0.6401  E[gain]=0.6580
    velocity_check        prior H=1.2982  E[posterior H]=0.6052  E[gain]=0.6929
    prior_dispute_record  prior H=1.2982  E[posterior H]=0.6052  E[gain]=0.6929

  point estimate H=0.0000 nats
    card_status           prior H=0.0000  E[posterior H]=0.0000  E[gain]=0.0000
    device_fingerprint    prior H=0.0000  E[posterior H]=0.0000  E[gain]=0.0000
    merchant_mandate      prior H=0.0000  E[posterior H]=0.0000  E[gain]=0.0000
    transaction_history   prior H=0.0000  E[posterior H]=0.0000  E[gain]=0.0000
    velocity_check        prior H=0.0000  E[posterior H]=0.0000  E[gain]=0.0000
    prior_dispute_record  prior H=0.0000  E[posterior H]=0.0000  E[gain]=0.0000

  eigIsDegenerate(point estimate) = true   selectProbe says: prior carries no entropy, so every probe has zero expected gain — nothing to disambiguate, or nothing that can express being torn
```

Zero entropy in, an unchanged posterior out, exactly zero expected gain for
every probe. A model that returns one answer supplies no basis for choosing
which lookup to run, because it reports nothing a lookup could reduce. The
probing in this example is downstream of the distribution existing at all.

#### What this does and does not show

Offline runs use scripted fixtures through `src/mock-fetch.ts`, which exercises
the real SDK code path with manufactured HTTP responses. The distributions above
were written by hand, and so were the probe costs and the partitions that decide
what each observation points towards. **The example proves what the application
does with a distribution. It never proves that the distribution deserves
trust.**

The arithmetic is real — the kernel computes expected entropy reduction
correctly over the numbers it is given. Whether those numbers are a faithful
prior is exactly what this repository does not establish.

This example previously resolved its ambiguity by routing to a human approval
gate. It no longer does, and that is worth stating precisely: **reversibility
plus verification makes an action undoable, which is a smaller property than
safe.** Removing the gate removed a demonstration choice, not a risk. Whether a
real card freeze or a real chargeback ought to require authorization is a
question about that action in that institution, and this repository does not
answer it.

The run prints a safety-ownership table separating properties owned by
deterministic code — eligibility, entitlement, argument binding, plan shape,
verification, reverse-order rollback, preflight freshness — from the rows marked
`unmeasured`, which are the ones this repository does not measure at all. The
fixtures are scripted precisely so that they cannot be measured by running it.

The full contract is `docs/CLAIM-CONTRACTS.md`; the limits of the pattern are
`docs/FSI-BOUNDARIES.md`.

<!-- fragment:08 -->

### 08 — Residual incident runbook routing, by expected information gain

[`examples/fsi/08-runbook-routing/index.ts`](examples/fsi/08-runbook-routing/index.ts)
— an overnight mainframe batch window produces sixteen incidents. Deterministic
sources answer most of them. What is left is put to Jev as a bounded choice over
applicable **remediation** runbooks plus `none-of-these` — and when that answer
is ambiguous, the distribution selects a read-only **diagnostic** runbook to run
next. Never a person.

```
npm run fsi:08
```

**Everything in this example is a scripted offline fixture.** The incidents, the
spool text, the CMDB, the flow snapshot, both runbook catalogs, the diagnostic
costs and — importantly — the model's answers and probability distributions are
all manufactured. Nothing calls the TypeSafe API unless `TYPESAFE_API_KEY` is set
and `JEV_MOCK` is not `1`, and the fault fixtures stay offline even then. The run
demonstrates control flow and arithmetic, not model accuracy.

Every code block below is copied from a real `npm run fsi:08` run. They are
excerpts — intermediate lines are elided for length — but no quoted line has
been edited.

#### Uncertainty selects the next machine action

When the distribution does not support acting, this example does exactly one of
three things, and "hand it to someone" is not among them:

1. **Probe** — run a read-only diagnostic chosen by expected information gain,
   fold the observation into the state, and ask again.
2. **Act reversibly** — execute the remediation, verify every step by reading the
   world back, and roll back in reverse order if verification fails.
3. **Refuse** — stop, state what could not be established, having changed
   nothing. Terminal. Not a queue, not a deferral.

The loop runs deterministic resolution first, because a model should never be
asked what a lookup can answer:

| Source | Answers |
|---|---|
| incident system | is this a repeat alert on an already-open incident? |
| scheduler dependency graph | is this job held behind a failed predecessor? |
| scheduler restart policy | is the scheduler already retrying a restartable abend? |
| reconciliation control | did a control total break, triggering a prescribed response? |
| abend mapping table | is this abend code mapped to a remediation? |

In this run those five sources resolve **7 of 16** incidents with no request
built at all, and the spool text never leaves the process for any of them.

#### The distribution over remediations selects a diagnostic

This is the part worth reading closely. Jev is asked which *remediation* the
evidence points to. What gets selected from the answer is which *diagnostic* to
run — a different catalog entirely. The link is that a diagnostic is worth
running exactly to the extent that its possible observations would split the
remediation candidates differently. Nothing anywhere says which diagnostic to run
for which symptom; it falls out of the shape of the prior.

`INC-4479` is the case the example exists for. Three subsystems alarm inside one
minute and the DB2 lock timeout is the loudest line in the window:

```
INC-4479  CBPOST45  flow=NIGHTLY-CORE · CIs=CBPOST, DB2P01, FXFEED · scheduler=ENDED_NOT_OK · SLA 05:30Z
  residual (multiple_symptoms_no_mapping): 3 symptom families in one window (db2, mq, dataset), none mapped
  judgement: RM-DB2-RELIEVE-LOCK 36.0% · RM-FEED-RESUPPLY 27.0% · RM-CTL-REBUILD 14.0% · margin 0.09 · H 1.620 nats · sufficiency 41%
    → DG-UPSTREAM-DEPGRAPH   cost  1  gain 1.007  gain/cost 1.007
      DG-FEED-TRAILER        cost  2  gain 0.579  gain/cost 0.290
      DG-DB2-LOCKSNAP        cost  3  gain 0.645  gain/cost 0.215
      DG-CTL-TOTALS          cost  3  gain 0.409  gain/cost 0.136
      DG-LOADLIB-DIFF        cost  2  gain 0.265  gain/cost 0.132
      DG-GDG-LIMIT           cost  2  gain 0.185  gain/cost 0.092
      DG-ABEND-DUMP-TRACE    cost  6  gain 1.089  gain/cost 0.182  ← outside the remaining budget
  PROBE  DG-UPSTREAM-DEPGRAPH (cost 1) — Find the earliest job in the flow that did not end cleanly
  reads the scheduler's dependency graph and last night's job states · observed "first-failure-upstream-feed" [computed: FXLOAD10 (FXFEED) is ENDED_NOT_OK at 2026-09-22T03:11:48Z, upstream of CBPOST45]
  H 1.620 → 0.091 nats predicted by Bayes (expected gain 1.007)
  re-judgement 1: RM-FEED-RESUPPLY 91.0% · RM-DB2-RELIEVE-LOCK 4.0% · RM-CTL-REBUILD 2.0% · margin 0.87 · H 0.438 nats · sufficiency 87%
  ACT  RM-FEED-RESUPPLY — all steps acted and verified
```

**The probe changed the winner.** A rate feed ended not-OK twenty-three minutes
earlier and paged nobody; the DB2 timeout was downstream of it. Probing that only
confirmed the leader would demonstrate nothing, so the fixture is built so it
does not.

That observation is also the one thing in the diagnostic catalog that is not
authored — `DG-UPSTREAM-DEPGRAPH` walks the flow snapshot and reports what it
finds, which is why the run labels it `[computed: …]` while every other
observation is labelled `[authored: scripted by the fixture author]`.

#### Cost-efficiency is not a tiebreak, it changes the answer

Selection ranks on `gainPerCost`, so the sharpest diagnostic is frequently not
the one to run. In `INC-4486` the split is 44% / 41% between a lock timeout and a
bad packed field, and the lock snapshot is the sharpest thing affordable:

```
  judgement: RM-DB2-RELIEVE-LOCK 44.0% · RM-DATA-0C7 41.0% · RM-CTL-REBUILD 6.0% · margin 0.03 · H 1.216 nats · sufficiency 45%
    → DG-UPSTREAM-DEPGRAPH   cost  1  gain 0.520  gain/cost 0.520
      DG-DB2-LOCKSNAP        cost  3  gain 0.680  gain/cost 0.227  ← sharpest, but not the best value
      DG-LOADLIB-DIFF        cost  2  gain 0.206  gain/cost 0.103
      ...
      DG-ABEND-DUMP-TRACE    cost  6  gain 0.934  gain/cost 0.156  ← outside the remaining budget
```

The dependency walk goes first at a third of the cost, because if it had found an
upstream failure it would have removed *both* live candidates at once. It does
not find one — and only then is the expensive discriminator worth its price:

```
  PROBE  DG-DB2-LOCKSNAP (cost 3) — Pull the DB2 lock snapshot for the plan and look for a blocking thread
  H 1.158 → 0.060 nats predicted by Bayes (expected gain 0.682)
  re-judgement 2: RM-DB2-RELIEVE-LOCK 90.0% · RM-DATA-0C7 5.0% · RM-CTL-REBUILD 2.0% · margin 0.85 · H 0.465 nats · sufficiency 88%
  ACT  RM-DB2-RELIEVE-LOCK — all steps acted and verified
```

This is why the budget has two dimensions. `maxProbes` alone would make every
diagnostic equally affordable and quietly remove the reason to rank on cost at
all; `maxCostUnits` is what makes an expensive check something you can decline.

#### A spent budget produces a refusal, not a deferral

`INC-4484` runs three diagnostics, every one comes back negative, and the
distribution never concentrates:

```
  re-judgement 3: RM-DB2-RELIEVE-LOCK 44.0% · RM-DATA-0C7 41.0% · none-of-these 6.0% · margin 0.03 · H 1.174 nats · sufficiency 47%
      DG-DB2-LOCKSNAP        cost  3  gain 0.650  gain/cost 0.217  ← outside the remaining budget
      DG-ABEND-DUMP-TRACE    cost  6  gain 0.848  gain/cost 0.141  ← outside the remaining budget
  REFUSED  distribution does not support acting on this evidence; no further probing (probe budget spent (3 of 3 diagnostics run))
  · selected probability 0.44 < 0.7
  · margin 0.03 < 0.25
  · normalized entropy 0.73 > 0.6
  · evidence sufficiency 0.47 < 0.6
  spent 3/3 probes and 5/5 cost units · nothing was executed
```

Note that the run records *what it could not afford* alongside what it ran. "The
check that would have settled this cost 3 and we had 2 left" is the part a reader
most wants to second-guess, so it is printed rather than filtered away.

#### Acting is safe because acting is undoable

`INC-4485` concentrates after one cheap probe, remediation runs, and its second
step fails verification:

```
  ROLLED BACK  RM-MQ-RESTART-CHANNEL — step "restart-channel" failed verification
    acted   record-depth: Record the current transmission queue depth on the incident
    verified record-depth: the depth is recorded
    acted   restart-channel: Stop and restart the sender channel
    FAILED  restart-channel: could not confirm the channel reports RUNNING and the queue depth is falling
    undone  restart-channel: stop the channel and restore its previous disposition
    undone  record-depth: clear the recorded depth
```

`src/compensate.ts` supplies the guarantees: preflight everything before touching
anything, verify each step by reading the world back, compensate in reverse
order, and refuse outright any plan that schedules work after a point of no
return. The world being acted on here is in-memory, so the *ordering* is real
control flow over a simulated system — this shows that a failed verification
triggers compensation correctly, not that any mainframe operation is reversible
in practice.

#### The safe path does not depend on Jev being right

`INC-4480` is scripted **confidently wrong**: 91% of the mass on a key-management
remediation whose preconditions authoritative state does not satisfy.

```
  judgement: RM-HSM-KEYSYNC 91.0% · RM-FEED-RESUPPLY 4.0% · RM-SCHEME-REARBITRATE 2.0% · margin 0.87 · H 0.438 nats · sufficiency 88%
  REFUSED  recommendation refused by revalidation against authoritative state
  · preconditions do not hold: HSM-01 is not in the incident's affected CI set
```

No threshold on a peaked distribution produces that refusal, and note that the
peak *also suppresses probing* — the information-gain machinery does not catch a
confident error either, because there is barely any entropy left to buy. Ordinary
code, reading authoritative state after the model has answered, is what catches
it.

The same discipline covers the transport. `INC-4481` returns HTTP 200 with no
`choice` and no `probabilities`; the SDK's types promise both and do not check
them at runtime, so the application validates before trusting any field.
`INC-4482` times out. Both refuse.

#### A point estimate cannot play this game at all

Expected information gain is `H(prior) - E[H(posterior)]`. For a point mass,
`H(prior) = 0`, and the posterior under any observation is the same point mass.
Every term is zero, for every diagnostic. The run demonstrates this on a real
prior from earlier in the same run rather than asserting it:

```
INC-4479's real first judgement, and the same judgement collapsed to its argmax
(RM-DB2-RELIEVE-LOCK at 100%) — which is all a point-estimate model would have returned.

  distribution  H = 1.620 nats
      DG-UPSTREAM-DEPGRAPH   cost  1  gain 1.007  gain/cost 1.007
      DG-FEED-TRAILER        cost  2  gain 0.579  gain/cost 0.290
      DG-DB2-LOCKSNAP        cost  3  gain 0.645  gain/cost 0.215
      DG-CTL-TOTALS          cost  3  gain 0.409  gain/cost 0.136
      DG-LOADLIB-DIFF        cost  2  gain 0.265  gain/cost 0.132
      DG-GDG-LIMIT           cost  2  gain 0.185  gain/cost 0.092
      DG-ABEND-DUMP-TRACE    cost  6  gain 1.089  gain/cost 0.182  ← outside the remaining budget

  point estimate  H = 0.000 nats · eigIsDegenerate = true
      DG-UPSTREAM-DEPGRAPH   cost  1  gain 0.000  gain/cost 0.000
      DG-FEED-TRAILER        cost  2  gain 0.000  gain/cost 0.000
      DG-GDG-LIMIT           cost  2  gain 0.000  gain/cost 0.000
      DG-LOADLIB-DIFF        cost  2  gain 0.000  gain/cost 0.000
      DG-DB2-LOCKSNAP        cost  3  gain 0.000  gain/cost 0.000
      DG-CTL-TOTALS          cost  3  gain 0.000  gain/cost 0.000
      DG-ABEND-DUMP-TRACE    cost  6  gain 0.000  gain/cost 0.000  ← outside the remaining budget
```

An argmax model does not find diagnostic selection *harder*. It finds every
diagnostic equally worthless, with nothing left to break the tie, because the
quantity being compared is identically zero. Every other example in this
repository would still function with a point estimate and merely lose something;
this one has no decision to make without a distribution.

#### What the ledger keeps

Every decision record retains the full probe trail: the diagnostic run, its
expected information gain computed *before* it ran, the prior entropy, the
observation, the posterior entropy, the cost — and `considered`, the complete
ranked set of diagnostics assessed at that step including the one chosen. That
last field exists because probe economy is a counterfactual question ("would a
different ordering have got there for less?") and the orderings not taken are
unrecoverable after the run. An absent `considered` means the run did not measure
it, never that it passed.

The record also contrasts the entropy Bayes *predicted* against the entropy of
the distribution the model actually returned on re-judgement, so an investigation
is replayable and second-guessable rather than merely reported.

#### Outcome

```
Summary
────────────────────────────────────────
  DETERMINISTIC RUNBOOK   3
  LINKED TO PREDECESSOR   1
  SCHEDULER RETRY         1
  SUPPRESSED DUPLICATE    1
  FREEZE DOWNSTREAM       1
  ACT                     3
  ROLLED BACK             1
  REFUSED                 5

  16 incidents · 7 settled by lookups before any request was built
  16 request(s) to Jev across 9 residual incident(s)
  7 diagnostic(s) run costing 11 authored cost unit(s)
  zero incidents routed to a person: every outcome above is a machine action or a refusal
```

#### What this does and does not show

The control flow is real, and so is the entropy arithmetic over the inputs. The
inputs are manufactured.

Nine of the ten diagnostics return an observation a fixture author wrote; only
`DG-UPSTREAM-DEPGRAPH` computes its answer. **The diagnostics are not the ones a
real SRE team would run, and their costs are invented budget units, not measured
execution times** — both were authored in this repository. The partitions that
say which observations are consistent with which remediations, and the re-judged
distributions, have the same author, so agreement between the Bayesian prediction
and the model's next answer is one person agreeing with themselves, not
corroboration.

Probe selection is greedy: one step of lookahead, no planning over sequences.
Nothing here is optimal. Seven probes across nine residual incidents means seven
probes against *these fixtures*, and says nothing about a real incident
population.

Redaction runs deterministically over the configured fields before anything is
sent, and it is pattern-based — vendor log text matching no configured pattern
survives into the request. Redaction over unstructured log output is best-effort,
not a guarantee.

This example shows what an application does with a distribution. It does not
show, and cannot show, that the distribution deserves trust.

<!-- fragments:end -->

### [`examples/fsi/eval/`](examples/fsi/eval) — what the thresholds are worth

Both examples gate on the same three distribution statistics, with numbers
chosen by their authors. `npm run fsi:eval` runs both examples as subprocesses,
reads their ledgers back, and re-scores every recorded decision against a sweep
of thresholds. Nothing in either pipeline is reimplemented to do it.

The table trades acting against investigating, which is the ordinary reason to
sweep a threshold. The column that matters is the last one: decisions that
**passed every distribution test and were then vetoed by deterministic code**.
That column is computed, not labelled — it falls out of comparing each recorded
decision's metrics against its own recorded thresholds and then reading whether
the executed action diverged from the recommendation.

There are three such decisions, two in example 07 and one in example 08, and
the sweep shows they do not go away. Example 08's half of the table:

```
  min mass  scored    acts  investigates  contradicted
      0.50       7       5             2             1
      ...
      0.90       7       4             3             1
      0.95       7       0             7             0
```

The `91%` recommendation to run a key-rotation runbook against a host that was
not in the incident's affected set clears every threshold up to `0.90`. Only
`0.95` excludes it, and `0.95` also shuts the automation off entirely — nothing
is acted on at all. It survives the tightening because it was never an uncertain
answer: it was a confident answer to a question asked against stale state.
Raising the bar discarded the sound acceptances first and left the wrong one
until the column reached zero.

That is the argument for keeping the deterministic preconditions, not for
picking a better number. A threshold sweep can buy you coverage or caution. It
cannot buy you the check that reads authoritative state.

**There is no accuracy column, deliberately.** The distributions come from
[`src/mock-fetch.ts`](src/mock-fetch.ts), which scripts both the answer and the
shape of the distribution around it. Scoring accuracy over manufactured
distributions would measure the fixture author, not the model. The fixture
labels in both examples are recorded as priors committed before the run, and
they are explicitly not treated as ground truth.

[`perturb.ts`](examples/fsi/eval/perturb.ts) is the live counterpart — it
measures how a real distribution moves when a spurious option is added or a
correct one removed, which is the question the offline sweep cannot ask. **It
has never been run**, for the same reason as everything else here.

---

## Running the examples

```bash
npm install
node examples/01-quickstart.ts   # or: npm run quickstart
npm run all                      # examples 01–04 and the FSI set, in order

npm run fsi:07                   # bounded next-step recommendation
npm run fsi:08                   # residual incident runbook routing
npm run fsi:eval                 # threshold sweep over both ledgers
npm run check:foundation         # 21 assertions over src/ledger.ts

npm run record                   # 05: real Chrome, recorded
npm run compare                  # 06: Jev vs a control model, side by side
```

There is no build step. The examples are `.ts` files executed directly by
**Node ≥ 22.18**, which strips types natively. The dependencies are the real
published SDKs — `@typesafe-ai/sdk`, `ai`, `@ai-sdk/gateway` and `zod` — and
nothing in `src/` reimplements any of them.

`npm run all` deliberately stops short of 05 and 06 so the repo keeps its
clone-and-run property. Those two add `webreel`, which downloads Chrome and
ffmpeg into `~/.webreel` on first use.

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
src/fixture-label.ts  SCRIPTED_MOCK vs LIVE_API labelling, applied to every FSI run
src/ledger.ts         JSONL decision ledger, metricsFor(), canonical hashing
src/ledger.check.ts   21 assertions over the above — npm run check:foundation
src/authority.ts      authoritative-state revalidation used by example 07
src/workflow-machine.ts  the permitted-transition machine 07 recommends within
src/runbook-catalog.ts   the bounded runbook option set for example 08
src/log-redact.ts     configured-field redaction for ledger payloads
examples/             the six TypeScript examples, plus site/ and python/
examples/fsi/         the two FSI examples and the eval harness
docs/media/           the recording produced by example 05
docs/SDKS.md          which SDK to use, and the naming trap between them
docs/CLAIM-CONTRACTS.md  what each FSI example is and is not allowed to claim
docs/FSI-BOUNDARIES.md   where the domain scope stops
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

## Not yet answered by this repository

This repo is deliberately narrow. It shows Jev used through the published `@typesafe-ai/sdk`, with ordinary TypeScript code building a bounded question, receiving a distribution, and applying an abstention or probe-selection rule outside the model. That is real application control flow. It is not evidence that the returned distribution is correct, calibrated, stable, or safe to automate in a bank.

The most important caveat is also the simplest: **nothing in this repository has ever been run against the live TypeSafe API.** No API key was used to produce anything you see here. Every Choice, Score, Noul, probability table, example output, and recording shown here is driven by manufactured responses from [`src/mock-fetch.ts`](src/mock-fetch.ts). The mock exercises the SDK request path and the surrounding policy code; it also manufactures both the selected answer and the shape of the distribution. An offline run proves the harness behaves under scripted model outputs. It does not tell you how the real service answers, how confident it is, how long it takes, or how often it is available.

The full FSI boundary document is [`docs/FSI-BOUNDARIES.md`](docs/FSI-BOUNDARIES.md). The README version is shorter because an architect who has read the examples mainly needs to know where the line is.

Open questions before this pattern belongs near production:

1. **Deployment and data handling.** This repo does not answer where request state is processed, which regions are used, what is retained, whether inputs are used for training, which subprocessors can see them, how support access works, or how deletion and encryption are enforced.
2. **Input classification and minimization.** The examples pass compact state objects. They do not decide whether real transaction records, account identifiers, payment narratives, customer text, spool logs, hostnames, or operational metadata may be sent to a third-party service at all.
3. **Probability semantics.** The strongest objection is fair: a model-produced distribution is still a model output, so why trust its shape more than its argmax? Treating a flat distribution as ambiguous is a useful heuristic. It becomes a safety property only after showing, on representative data, that confidence correlates with correctness, calibration survives service updates, high-confidence errors are rare enough, and thresholds are not invalidated by adding, removing, reordering, or rewording the option set. None of that evidence is here.
4. **Evidence beyond fixtures.** The FSI examples can show what the policy would do for scripted confident, ambiguous, malformed, timeout, and fallback cases, and [`examples/fsi/eval/`](examples/fsi/eval) can show how that policy's behaviour moves as its thresholds move. Both operate over manufactured distributions. They do not measure model quality, risk coverage, service reliability, or live cost.
5. **Degraded operation.** The examples include fail-closed branches, but not production timeout budgets, retry policy, idempotency keys, duplicate-request handling, circuit breakers, fallback UX, or queue operations when the service is slow or unavailable.
6. **Change governance.** Candidate catalogs, thresholds, eligibility rules, prompt wording, SDK versions, and service versions are all control surfaces. This repo does not define who approves changes, how they are tested, how rollback works, or how evidence is retained.
7. **Automation bias, and what replaced it.** Escalation to a human is not automatically a control: reviewers anchor on the preselected answer, rubber-stamp queues under load, or lack the evidence needed to disagree. These examples do not have that failure mode, because they never route to a person — but the converse is now true and is the sharper limitation. There is no human in these loops at all, so the only things standing between a confident wrong distribution and an executed action are the deterministic preconditions and the compensating saga. Both are code in this repo, written by the same authors as the thing they check. Removing the reviewer removed the reviewer's rubber stamp and the reviewer's veto together.
8. **Ledger trust.** Emitted JSON records are useful for replay and debugging, but they are not an audit trail merely because they exist. Immutability, completeness, access control, retention, independent verification, and tamper evidence are not implemented.
9. **Baseline comparison.** The repo does not prove this pattern is better than rules, search, existing classifiers, metadata lookups, or asking an operator. In some domains the deterministic baseline is the right answer.
10. **Threat model.** Bounded output prevents Jev from inventing a new option. It does not prevent malicious or stale input from shifting probability toward a harmful option that your code made eligible.

Those gaps do not invalidate the examples. They define what the examples are: SDK wiring, bounded option construction, deterministic eligibility checks, abstention policies, fallbacks, and ledgers around scripted distributions. The missing work is the empirical and operational evidence required to trust the distribution in a regulated workflow.

---

## Six things worth internalizing

1. **Ask atomic questions.** "Is this a good response?" is three questions
   wearing a trench coat. Decompose, then combine in code.
2. **Ask them all at once.** Parallel and isolated means extra questions are
   nearly free in latency and cannot hurt each other's answers.
3. **Keep the distribution.** The argmax throws away the most useful thing you
   were given. A split distribution means *probe*, not *guess* — and a point
   estimate cannot tell you which probe is worth running, because expected
   information gain over a point mass is zero for all of them.
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
