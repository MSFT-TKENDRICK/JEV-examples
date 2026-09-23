# Claim contracts

Written **before** the example code, deliberately. The order matters: if you build
the demo first and write the claims afterwards, you write the claims the demo
seems to support, and a scripted demo appears to support almost anything.

The central discipline:

> The examples prove what the application does with a distribution, not that the
> distribution deserves trust.

The runnable Jev integrations use Vercel's live TypeSafe-compatible API by default,
with `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` and model `typesafe-ai/jev`.
Explicit `JEV_MOCK=1` selects fixture responses; the
threshold sweep and fault-injection checks are intentionally fixture-only.
Committed excerpts and the browser recording are fixture captures, not live
evidence. These contracts still apply to live runs: connectivity and decisions on
synthetic scenarios do not establish calibration, reliability or production safety.

Each contract below must be reproduced in the header comment of the example it
governs and in that example's README section. If a sentence you want to write is
not on the allowed list, it does not go in.

---

## Architecture contract — applies to every example

This section supersedes anything below it that disagrees. It was written after a
review found that every example resolved uncertainty by handing the decision to a
person, which demonstrates a model that defers rather than one that is useful.

### The rule

**Uncertainty selects the next machine action. It never selects a person.**

No example may route a decision to a human reviewer, approver, operations queue,
ticket, or escalation path as its answer to an ambiguous distribution. When the
distribution is flat, the application must do one of exactly three things:

1. **Probe** — run a read-only action chosen to maximise expected information
   gain, observe the result, re-judge.
2. **Act reversibly** — take an action it can verify and undo, then verify.
3. **Refuse** — stop, with a stated reason, having changed nothing.

"Refuse" is a terminal state of the program, not a handoff. It does not create a
review item and does not assume anyone is watching.

### May claim

- Given a distribution over candidates and a set of read-only probes, the
  application selects the probe with the highest expected reduction in entropy,
  and this selection is computed, not scripted.
- The probe ranking, the observation, and the posterior are recorded, so the
  chain from uncertainty to action is inspectable after the fact.
- A point estimate makes every probe's expected information gain **exactly
  zero**, because a distribution with all mass on one candidate has zero entropy
  and its posterior under any observation is unchanged. This is arithmetic, and
  `src/information-gain.check.ts` asserts it.
- Therefore an argmax-only interface supplies no basis for choosing what to
  investigate next. This is a claim about what information a single answer
  carries, and it holds regardless of which model produced the answer.
- Irreversible steps run last, after reversible ones have been verified, and the
  runner rejects any plan that violates this.
- A failed compensation is reported as `inconsistent` and is a loud failure, not
  a resolved state.

### Must not claim

- That expected information gain makes the probe sequence optimal. It is greedy
  and one-step-lookahead; a plan that looks two probes ahead can beat it.
- That the probes are the right probes. Which probes exist, what they cost, and
  how their observations partition the candidates are **authored by the fixture**.
  The arithmetic over those inputs is real; the inputs are manufactured.
- That autonomy is safer than human review, or that removing the approval gate
  removed a risk. It removed a *demonstration choice*. Whether a given action
  should require authorization is a question about that action, and this
  repository does not answer it.
- That the entropy drop across a run measures anything about Jev's calibration.
  In the committed captures the prior was scripted, so the posterior is a
  consequence of the script. Live entropy changes alone are not calibration
  measurements either.
- That a generative model cannot probe. It can; the claim is narrower and is
  about what a bare point estimate supplies, not about what a system built
  around one can be made to do.

### Design constraints this implies

1. No example may import an approval, review, or escalation module. The vocabulary
   is banned from routes and outcomes: `escalate`, `approval_required`,
   `ops_queue`, `review`, `handoff`.
2. Probes must be genuinely read-only and must be cheaper than the action they
   inform, or the example is arguing for itself dishonestly.
3. Every example must show at least one run where probing **changes** the answer,
   and one where the budget is exhausted and the application refuses. An example
   in which probing always confirms the leader has demonstrated nothing.
4. The comparison arm must fail *attributably* — the narration must name the
   capability it lacked, not merely report a worse score.

---

## Example 07 — Bounded next-step recommendation

### May claim

- Deterministic code constructs the eligible option set **before** the Jev request.
- Ineligible actions are never supplied as Choice options.
- The application applies an explicit abstention policy to the returned
  distribution, and resolves ambiguity by fetching further evidence rather than
  by consulting a person.
- Argument binding is step-specific and accepts only authoritative record
  identifiers or exact permitted source spans.
- The fixture proves that an unbound merchant, amount or record identifier is
  rejected **by application code**. The fixture exercises one scripted proposal;
  the check itself does not consult which model produced it.
- Consequential actions run through the act/verify/compensate runner, which
  verifies each reversible step before proceeding and places the single
  irreversible step last.
- A step whose verification fails triggers compensation of the steps already
  taken, in reverse order.
- The ledger records Jev's recommendation and the executed action in separate
  fields, and derives whether they differ.
- The offline run exercises the published SDK code path with manufactured HTTP
  responses.

### Must not claim

- Jev correctly understands fraud reports.
- Jev is calibrated for banking workflow selection.
- Jev prevents hallucination, in general or in particular.
- Jev provides authorization, or makes any action safe.
- Bounded options imply a correct or harmless choice.
- The pattern safely automates card freezes or dispute filing.
- The pattern reduces fraud loss, handling time, or clarification turns.
- Reversibility plus verification makes an action safe to take without
  authorization. It makes the action **undoable**, which is a different and
  smaller property.
- The fixture output demonstrates live TypeSafe API behaviour, latency, cost or
  reliability; or a live example run establishes representative service quality.
- The generative control arm represents all Vercel AI SDK or tool-calling
  implementations. *(A competent generative implementation can also be constrained
  to enumerated IDs and subjected to the same referential checks. The control arm
  is a fixture, not a fair benchmark, and must say so.)*

### Design constraints this contract implies

1. Ask for the **next workflow step**, never "which tool to call". A single Choice
   over co-applicable actions forces a single-choice framing onto a multi-step
   workflow, and a peaked answer to an ill-posed question is still wrong.
2. Bind arguments in a **subsequent, step-specific stage**. Independently selected
   marginals — tool, card, transaction — do not compose into a coherent joint
   decision, and candidate arguments are conditional on the selected step.
3. Name the **principal and the reversal path** for every consequential action.
   An action the application cannot undo must be the last thing it does, and the
   narration must say what would remain if it failed.
4. Route genuinely authored content away from Jev: callback times come from the
   scheduler's availability, the dispute narrative preserves the customer's exact
   text, free notes are stored as untrusted customer input.

---

## Example 08 — Residual incident runbook routing

### May claim

- Known structured mappings and dependency conditions are resolved
  deterministically first.
- Jev receives only a controlled catalog of candidate runbooks plus `none`.
- When the distribution over **remediation** runbooks is ambiguous, the
  application selects a **diagnostic** runbook to run — read-only, cheaper than
  remediating, and chosen by expected information gain over the remaining
  candidates.
- The observation from a diagnostic run is fed back as evidence and the judgement
  is repeated, with the entropy before and after both recorded.
- The application remediates autonomously once the distribution concentrates, and
  refuses — changing nothing — when the probe budget is exhausted without
  concentration.
- The safe fallback does not depend on Jev returning a correct answer.
- Log preprocessing extracts bounded diagnostic windows and deterministically
  redacts **the configured** fields, before anything is sent. Redaction over
  unstructured vendor log text is best-effort: content matching no configured
  pattern survives into the request.
- Scripted fixtures exercise confident, ambiguous, probe-resolved,
  budget-exhausted, malformed-response and timeout paths.
- The ledger distinguishes the recommendation from the route actually taken, and
  retains the full probe trail.
- The example demonstrates bounded residual routing control flow.

### Must not claim

- Jev identifies root cause.
- Jev correctly understands abend codes or spool output.
- Jev selects the correct owner or runbook.
- The returned probabilities are calibrated.
- The diagnostic runbooks are the ones a real site reliability team would run, or
  that their costs reflect real execution times. Both are authored.
- That fewer probes than a naive baseline means fewer probes against a real
  incident population. It means fewer probes against **these fixtures**.
- The pattern reduces MTTR, paging volume or misrouting.
- The CMDB or runbook catalog is complete or current.
- Recent deployments are causally responsible for the failure.
- A log tail is sufficient evidence.
- The routing is safe to automate without task-specific validation.
- The offline example demonstrates live reliability, cost or latency.

### Design constraints this contract implies

1. Jev must never rediscover an owner that already exists in the scheduler or
   CMDB. If a deterministic source knows the answer, the deterministic source
   answers.
2. Choose the **first diagnostic runbook**, not the owning team. Ownership belongs
   in metadata; choosing among several applicable diagnostic procedures can remain
   genuinely semantic — and it is a choice a distribution is directly useful for,
   because the value of a diagnostic is defined by how much it would move the
   distribution.
3. A raw log tail is not a state-construction strategy. It may omit the causal
   event entirely while preserving only cleanup noise, and it may carry account
   data, tokens, dataset names or internal hostnames.
4. Define the target precisely. Ownership is often multi-label — application,
   scheduler, database and upstream feed teams may all be involved — and a single
   Choice over a poorly defined target is wrong regardless of its shape.

---

## Ledger

### May claim

- The schema captures the specified application-visible inputs, distributions,
  policy values, routes and outcomes.
- It distinguishes the service's recommendation from the harness's action.
- It retains the probe trail — probe id, expected gain, prior and posterior
  entropy, observation and cost — so the investigation sequence can be replayed
  and second-guessed.
- It records execution outcomes including rollback and `inconsistent`, so a run
  that left partial effects behind is visible rather than reported as handled.
- It labels scripted and live modes separately.
- It can support replay, debugging and comparison, and may support later
  governance work if records are complete and protected.

### Must not claim

- It is an audit trail merely because it emits records.
- It is tamper-evident, immutable, complete or independently verified.
- It satisfies SR 11-7, OCC, FFIEC, PCI DSS, SOX or internal model-risk
  requirements.
- It proves reproducibility. A scripted run is reproducible when fixtures, code,
  candidate catalogs, policies and service versions are all retained; a
  `LIVE_API` run is not reproducible regardless of what is retained.
- Hashed state is anonymous or non-sensitive.
- Raw distributions explain why the service produced a result.
- Evidence capture establishes validity, calibration, fairness or production
  fitness.

---

## Evaluation harness

Built: `examples/fsi/eval/`, entry point `npm run fsi:eval`.

### May claim

- The offline sweep measures **how the policy behaves** across the fixture
  population as thresholds move.
- It reports, per threshold, the number of recorded decisions scored, acted on,
  probed and refused.
- It reports **probe economy**: at each recorded probe step, whether a naive
  cheapest-first policy would have chosen differently, and where it would have,
  the ratio of cost paid to expected information gained. Computed from
  `ProbeRecord.considered`, the option set as assessed at that step.
- **Probe economy is per-step and reports no trajectory total.** Running a
  different probe first produces a different observation and a different
  posterior, so only the first step of the alternative policy is recoverable
  from a trail that policy never generated. Steps whose option set was not
  recorded are reported as `unmeasured`, never as a pass.
- It reports a **contradicted** count: decisions whose recorded metrics cleared
  their own recorded thresholds, but whose executed action diverged from the
  recommendation because deterministic code vetoed it. This is computed from
  the ledger, not read from a label.
- It runs both examples as subprocesses and reads their ledgers, so it exercises
  the real pipelines rather than a reimplementation of them.
- The live perturbation harness ships as runnable code requiring Gateway credentials
  (`AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`) and rejecting `JEV_MOCK=1`. It measures candidate-set changes
  against synthetic state without executing the recommended actions.

### Must not claim

- The sweep measures Jev's calibration or accuracy. It measures a policy applied
  to **scripted** distributions, which were manufactured by `src/mock-fetch.ts`.
- The resulting curve is a risk/coverage curve for the model.
- Accuracy, correctness, or "would have acted wrongly" counts against the
  fixture labels. Those labels are priors committed by the fixture author, not
  ground truth, and the distributions were manufactured alongside them — any
  accuracy figure would describe the author rather than the model. **The sweep
  therefore has no accuracy column, and must not grow one while the fixtures
  are scripted.**
- That the contradicted count is a measured error rate. It is a count of two
  hand-written fixtures that were built to contain exactly that case.
- That the probe-economy figure generalises. It compares two policies over
  authored probe costs and authored partitions; change the fixture and the
  ranking can change. It shows the mechanism works, not that it pays.
- That probe economy describes what cheapest-first would have cost overall. It
  describes single steps only, and summing those steps into a total would be a
  fabrication.
- That a `rankingViolations` count of zero is evidence the selector is good. The
  shipped ranking is gain-per-cost, so under it that count is zero by
  construction; it is a consistency check on the recorded trail, nothing more.
- That the table shows how sensitive **the policy** is to its thresholds. It  sweeps one knob, `minSelectedProbability`, holds `minMargin` and
  `maxNormalizedEntropy` at their shipped values, and does not vary the
  probe-side thresholds — the probe budget, and the gain floors a probe must
  clear — at all. It is the sensitivity of one gate. Describing it as the
  policy's sensitivity would imply the probe budget had been varied and found
  not to matter, which no run here tested.
- That a step with one recorded option is unmeasured. The trail recorded it;
  it says the selector had nothing to choose between. `unmeasured` is reserved
  for a step whose alternatives were never written down. Folding the two
  together sends a reader looking for a missing record that exists, and
  inflates the count of things this repository failed to measure.
- The perturbation results are known. **No live perturbation results are published here.**
  The repo ships the instrument, not the findings.
- That raw shared-option mass deltas establish accuracy or calibrated stability.
  Adding or removing options changes normalization, and one sample per variant
  cannot separate sampling variation from option-set effects.
