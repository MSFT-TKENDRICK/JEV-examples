# Where not to use this pattern

This repository demonstrates one pattern: **Jev returns a probability distribution
over a bounded option set, and application code turns that distribution into an
explicit action, probing or refusal policy.**

This document is about the limits of that pattern. It exists because the rest of
the repo would otherwise invite overclaiming, and because in financial services
the cost of an overclaim is not embarrassment — it is a control failure.

## The claim this repo is allowed to make

> Jev exposes a distribution over a bounded action space, letting the application
> implement explicit action, probing and refusal policies. Whether those policies
> improve safety or efficiency must be validated empirically for each domain.

Everything below follows from taking that sentence literally.

The examples call live Jev through Vercel by default with `AI_GATEWAY_API_KEY`
or `VERCEL_OIDC_TOKEN`; only explicit `JEV_MOCK=1` opts into scripted Jev responses.
No direct TypeSafe credential or endpoint is used. Their records, incidents and action
targets remain synthetic. The published excerpts and recording are fixture
captures, not evidence of live model quality. Deterministic eligibility and
preconditions constrain which actions may run; Jev still supplies the semantic
decision distribution over the eligible alternatives.

## Bounded output is not safe action

An enumerated option set stops Jev inventing a *new* label. That is the entire
guarantee. It does **not** stop the model:

- choosing the wrong option from the ones you supplied;
- acting on stale, incomplete, or maliciously constructed state;
- producing a sharply-peaked distribution that is confidently wrong;
- selecting the nearest plausible candidate when the correct one was never
  retrieved.

So "the output is constrained" and "the decision is safe" are different claims
with different evidence requirements. Conflating them is the single most common
error this document is trying to prevent.

## The distribution is not self-validating

The strongest objection to the whole pattern is fair:

> "A model-produced distribution is still a model output. Why should I trust its
> shape more than its argmax?"

Treating a flat distribution as "ambiguous" is an intuitively useful heuristic.
It becomes a *safety property* only once you can show, on your own data, that:

- confidence correlates with correctness;
- low-confidence cases are genuinely enriched for errors;
- high-confidence errors are rare enough to accept;
- calibration survives model updates;
- option-set composition does not destabilize the probabilities;
- the chosen threshold produces an acceptable risk/coverage tradeoff.

None of that is demonstrated here, and none of it is measured here.
`examples/fsi/eval/` ships the *instrument*, not the results: the offline sweep
runs over manufactured distributions and so can only characterize the policy,
and `perturb.ts` — the only part that could speak to option-set stability —
requires a real key. No live perturbation measurements are published here.

One negative result does fall out of the offline sweep, and it is worth stating
because it cuts against the pattern rather than for it: the two fixtures where
deterministic code vetoed an accepted recommendation are not removed by any
threshold that leaves the automation switched on. Confidence thresholds did not
catch a confident answer to a question asked against stale state, because there
was nothing uncertain about it. That is a property of the fixtures, not a
measurement — but it is the failure mode the table below describes, made
concrete.

### Known failure modes

| Failure | Why abstention does not catch it |
|---|---|
| **Peaked and wrong** | Out-of-distribution inputs can produce concentrated errors. A flatness test passes them straight through. |
| **Option-set sensitivity** | Adding, removing, reordering or rewording candidates can move the distribution. A threshold tuned for 3 options is not valid for 20. |
| **Missing correct option** | With no explicit `none-of-these`, the model is forced to be wrong. Even with one, it may prefer a near-miss. |
| **Bad upstream state** | A distribution cannot repair wrong retrieval, stale reference data, bad OCR, or omitted evidence. |
| **Correlated judge failure** | If a generative proposer and Jev read ambiguous language the same way, Jev may confidently endorse the same mistake. "A different call" is not automatically independent assurance. |

## Prohibited uses of *this* pattern

These are scoped statements about the unvalidated pattern in this repository, not
sweeping claims about AI in financial services. Institutions do use models in many
of these areas, under governance this repo does not implement.

### Credit approval, pricing, adverse action or reason codes

Do not use this pattern as a credit decisioning, pricing, adverse-action or
reason-code system. There is no validation on lending data, no monotonicity or
stability guarantee, no fairness or disparate-impact evaluation, and no governance
evidence. Critically, **probabilities are not reasons** — a distribution cannot
produce the specific, accurate, causal adverse-action reason that consumers are
entitled to, and an explanation generated alongside a decision is not guaranteed
to faithfully describe that decision.

### AML or sanctions auto-clear

Do not use this pattern to close, clear, or dispose of AML alerts or sanctions
hits. Disposition is legally consequential, and a rubric distribution is not a
regulator-ready reason. Name screening and entity disambiguation may be acceptable
as *analyst decision support* — ranked candidates with mandatory human
disposition, explicit `none-of-these`, and no auto-clear path — but that is a
different system from the one shown here.

### Payment mutation

Do not use this pattern to repair, enrich, re-route or resubmit a payment message.
Deterministic validation (schema, market practice, checksums, participant
directories, routing tables) must resolve what it can first, and a probabilistic
third-party service does not belong in a deterministic straight-through-processing
path. Read-only candidate suggestion to an operator reduces blast radius; it does
not eliminate it, because operators anchor on recommendations.

### Authorization and authentication

Do not use a distribution to decide whether a principal may do something.
Authorization is a deterministic property of identity, entitlement and account
state. In this repo it is computed *before* Jev is consulted, and Jev is never
shown an action the principal could not take.

### Suitability determination

Do not use this pattern to decide whether advice, a product, or a recommendation
is suitable for a customer. A "groundedness" or "completeness" score establishes
none of: that every claim is supported, that citations entail the claims, that all
applicable policy documents were retrieved, that those documents are current, or
that required disclosures were present.

### Regulatory scope as the sole control

Do not let a model decide whether a change, system, or record is in regulatory
scope. Scope should come from authoritative metadata — service inventories,
CODEOWNERS, path rules, component catalogs, data classification, policy-as-code.
If scope depends on a model reading a diff, that is a control-design problem the
model cannot fix.

### Security enforcement as the sole detector

Do not use a Noul as a security boundary — prompt-injection detection in
particular. The detector must itself consume the untrusted content, and injection
is not reliably characterized by whether text "looks like an instruction":
obfuscation, encoding, splitting across documents, image and metadata channels,
and benign-until-paired payloads all defeat it, while legitimate business email
routinely contains instructions. **A sharp probability is not a security
boundary.** The real mitigations are architectural: treat content as data, apply
least privilege, allowlist egress, track taint, and sandbox execution.

## Candidates considered and rejected

Two adversarial design reviews cut a nine-scenario slate to two examples. The
rejections are recorded here because *why an example does not exist* is as
informative as the ones that do.

| Candidate | Verdict | Reason |
|---|---|---|
| AML / sanctions alert triage | **Rejected** | Puts an unvalidated model in the disposition path for legally consequential alerts. The most likely example to damage credibility. |
| ISO 20022 payment repair | **Rejected** | Probabilistic service in a deterministic STP path; a payments engineer stops listening at "repair". |
| Payment exception candidate matching | **Rejected** | Reworked into read-only suggestion, then cut: it enters a mature matching category and needs comparative accuracy evidence a scripted repo cannot supply. |
| Prompt-injection detector | **Rejected** | A probability is not a security boundary. Retained at most as one non-authoritative signal, never as a control. |
| PR compliance-scope classifier | **Rejected** | Scope belongs in authoritative metadata. Also duplicates the existing rubric example. |
| Advisor RAG / suitability gate | **Rejected** | Implies compliance assurance far beyond what is implemented; "completeness" is unknowable to an evaluator that cannot see what retrieval missed. |
| Entity / sanctions disambiguation | **Deferred** | Defensible as analyst-only decision support, but the sanctions framing invites an auto-clear reading. Counterparty deduplication would be the safer form. |

## Questions this repository does not answer

An architect will ask these in the first five minutes. None are answered here.

1. **Where does the data go?** Deployment topology, region, residency, retention,
   training use, subprocessors, support access, encryption, deletion.
2. **What may be sent at all?** Transaction data, account identifiers, payment
   narratives and operational logs each need classification and minimization.
3. **What do the probabilities mean?** Calibrated against what? Stable across
   candidate-set changes? Comparable across service versions?
4. **What evidence exists beyond manufactured responses?** Harness behaviour is
   verified. Service quality, latency, availability and accuracy are not.
5. **What happens when the service degrades?** Timeout budgets, retries, duplicate
   requests, circuit breaking, idempotency, fallback, degraded-mode UX.
6. **How are changes governed?** Who approves a new candidate, threshold, service
   version or eligibility rule, and how is rollback handled?
7. **How is automation bias prevented?** "Human in the loop" is weak if reviewers
   routinely accept the preselected answer, or if the queue is unstaffed.
8. **Is the ledger trustworthy?** Application-emitted JSON is not inherently
   immutable, complete, access-controlled or independently verifiable.
9. **What is the baseline?** Rules, search, existing classifiers, or simply asking
   the operator may be cheaper and more reliable.
10. **What is the threat model?** A bounded output does not stop malicious input
    from shifting probability toward a harmful *eligible* action.
