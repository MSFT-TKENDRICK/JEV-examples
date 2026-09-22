# Claim contracts

Written **before** the example code, deliberately. The order matters: if you build
the demo first and write the claims afterwards, you write the claims the demo
seems to support, and a scripted demo appears to support almost anything.

The central discipline:

> The examples prove what the application does with a distribution, not that the
> distribution deserves trust.

Each contract below is reproduced in the header comment of the example it governs
and in that example's README section. If a sentence you want to write is not on
the allowed list, it does not go in.

---

## Example 07 — Bounded next-step recommendation

### May claim

- Deterministic code constructs the eligible option set **before** the Jev request.
- Ineligible actions are never supplied as Choice options.
- The application applies an explicit abstention and escalation policy to the
  returned distribution.
- Argument binding is step-specific and accepts only authoritative record
  identifiers or exact permitted source spans.
- The fixture proves that an unbound merchant, amount or record identifier is
  rejected **by application code**, regardless of which model proposed it.
- The harness requires approval for configured consequential actions.
- Approval is a separate step from Jev's recommendation, bound to an immutable
  proposal digest and revalidated against fresh state.
- The ledger records a difference between what Jev recommended and what the
  application executed.
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
- The example demonstrates live TypeSafe API behaviour, latency, cost or
  reliability.
- The generative control arm represents all Vercel AI SDK or tool-calling
  implementations. *(A competent generative implementation can also be constrained
  to enumerated IDs and subjected to the same referential checks. The control arm
  is a fixture, not a fair benchmark, and must say so.)*
- Human confirmation by itself satisfies any regulatory, authorization or
  operational requirement.

### Design constraints this contract implies

1. Ask for the **next workflow step**, never "which tool to call". A single Choice
   over co-applicable actions forces a single-choice framing onto a multi-step
   workflow, and a peaked answer to an ill-posed question is still wrong.
2. Bind arguments in a **subsequent, step-specific stage**. Independently selected
   marginals — tool, card, transaction — do not compose into a coherent joint
   decision, and candidate arguments are conditional on the selected step.
3. Name the **authorization principal** for every approval. Customer, agent and
   operations reviewer are not interchangeable.
4. Route genuinely authored content away from Jev: callback times come from the
   scheduler's availability, the dispute narrative preserves the customer's exact
   text, free notes are stored as untrusted customer input.

---

## Example 08 — Residual incident runbook routing

### May claim

- Known structured mappings and dependency conditions are resolved
  deterministically first.
- Jev receives only a controlled catalog of candidate runbooks plus `none`.
- The application routes ambiguous or split distributions to the ordinary
  operations queue.
- The safe fallback does not depend on Jev returning a correct answer.
- Log preprocessing extracts bounded diagnostic windows and redacts sensitive
  fields deterministically, before anything is sent.
- Scripted fixtures exercise confident, ambiguous, malformed-response, timeout and
  fallback paths.
- The ledger distinguishes the recommendation from the route actually taken.
- The example demonstrates bounded residual routing control flow.

### Must not claim

- Jev identifies root cause.
- Jev correctly understands abend codes or spool output.
- Jev selects the correct owner or runbook.
- The returned probabilities are calibrated.
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
   genuinely semantic.
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
- It labels scripted and live modes separately.
- It can support replay, debugging and comparison, and may support later
  governance work if records are complete and protected.

### Must not claim

- It is an audit trail merely because it emits records.
- It is tamper-evident, immutable, complete or independently verified.
- It satisfies SR 11-7, OCC, FFIEC, PCI DSS, SOX or internal model-risk
  requirements.
- It proves reproducibility, unless fixtures, code, candidate catalogs, policies
  and service versions are all retained.
- Hashed state is anonymous or non-sensitive.
- Raw distributions explain why the service produced a result.
- Evidence capture establishes validity, calibration, fairness or production
  fitness.

---

## Evaluation harness

### May claim

- The offline sweep measures **how the policy behaves** across the fixture
  population as thresholds move.
- It reports auto-handled fraction, escalation rate and would-have-acted-wrongly
  counts against fixture-assigned labels.
- The live perturbation harness is implemented and ready to run against a real
  `TYPESAFE_API_KEY`.

### Must not claim

- The sweep measures Jev's calibration or accuracy. It measures a policy applied
  to **scripted** distributions, which were manufactured by `src/mock-fetch.ts`.
- The resulting curve is a risk/coverage curve for the model.
- The perturbation results are known. **The live path has never been executed.**
  The repo ships the instrument, not the findings.
