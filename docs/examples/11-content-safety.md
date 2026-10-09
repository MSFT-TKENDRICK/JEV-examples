# 11 — Content safety: deterministic rules first, then semantic policy checks

[`examples/fsi/11-content-safety/index.ts`](../../examples/fsi/11-content-safety/index.ts) — run with `npm run fsi:content-safety`.

A rules engine runs before any model. A card number in a post is redacted by a
deterministic rule, and no request is built. Everything the rules do not settle goes to
Jev, with the policy's own clauses as the bounded options, and Jev may also flag personal
data about a third party. An opt-out request is accepted only when a rule also matches the
text. Policy linting uses the same loop over a different list of findings.

**Fixture constraint.** The output is from `JEV_MOCK=1`. The posts, clause list and lint
findings are authored, not a real policy. The card-number and opt-out patterns are simple
on purpose.

## Captured output (fixture run)

```
Summary
  POST-901                 completed    card-number pattern matched  no probe
  POST-914                 completed    clause-4.1-guaranteed-returns 1 probe(s), cost 1 · probe changed the answer
  POST-921                 completed    request-opt-out              no probe
  POST-930                 refused      clause-4.4-unsolicited-contact 1 probe(s), cost 1
  POLICY-P-17              completed    ambiguous_standard           no probe
```

POST-901 never reaches Jev: the rule redacts the number and keeps the original for
reversal. POST-914 starts flat between unsolicited contact and guaranteed returns. The
sender's account is two days old, the probe reads that, and Jev moves to guaranteed
returns at 80%. POST-930 is flat and its one probe does not settle it, so the post is left
unchanged.

## Requested use cases, and what this example does with each

| Requested | Here |
|---|---|
| Detect toxicity, harassment, spam, fraud, unsafe advice, personal-data exposure, opt-out requests and policy-violating claims | One bounded clause choice covers spam (4.4), guaranteed returns (4.1), unsafe advice (5.2), harassment or toxicity (6.1), and impersonation (7.3). Personal data is a yes/no indicator. Opt-out is a choice gated on a rule |
| Rules engine routing | Deterministic patterns run first and settle what they match. Residual posts go to Jev |
| Semantic policy enforcement | The policy's clauses are the only options Jev may choose. A clause outside the list cannot be returned |
| Semantic linting | Policy sentences are classified against a fixed list of lint findings |

## Claims

**This example may claim:** that a rule can settle a case before any model is asked; that
the model's choice is bounded to the policy's clauses; that a probe on the sender's account
age can change the clause; that an opt-out is accepted only when the text confirms it.

**It must not claim:** that any post is safe or unsafe, or that it breaches a regulation;
that the clause list is a real policy; that the rules catch what they do not match; that
visibility limits or suppression flags remove anything. This is not a security boundary,
and an injection-resistant detector is a separate problem, as
[`docs/FSI-BOUNDARIES.md`](../FSI-BOUNDARIES.md) notes.

See [`docs/CLAIM-CONTRACTS.md`](../CLAIM-CONTRACTS.md#examples-09-14--industry-scenarios).
