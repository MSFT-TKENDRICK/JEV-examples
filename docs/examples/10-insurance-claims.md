# 10 — Insurance claims: first-notice classification and risk indicators

[`examples/fsi/10-insurance-claims/index.ts`](../../examples/fsi/10-insurance-claims/index.ts) — run with `npm run fsi:insurance-claims`.

Jev classifies a first-notice-of-loss report by claim type. In the same request it
answers two yes/no questions: whether documents are missing, and whether the report has
fraud indicators. A probe reads the claim history or the document checklist when the
answer is flat. A gate refuses a claim with no policy in force, or with a fraud indicator
at or above 0.5. Accepted claims get a type, a processing lane and the stored risk
indicators. All three writes are reversible, and the last one can fail and roll the others back.

**Fixture constraint.** The output is from `JEV_MOCK=1`. The reports, policies and
document checklists are authored. A "standard" lane is a label, not a payment.

## Captured output (fixture run)

```
Summary
  FNOL-5530                completed    property_water               no probe
  FNOL-5544                refused      injury                       1 probe(s), cost 1 · probe changed the answer
  FNOL-5551                refused      motor_collision              1 probe(s), cost 1
  FNOL-5560                rolled_back  property_water               no probe
```

FNOL-5544 starts torn between motor and injury. The claims history shows three claims in
twelve months, Jev moves to injury at 78%, and the fraud indicator reads 71%. The gate
refuses, and the claim is not set. FNOL-5560 is confident, but the annotation store is
down. The claim type and lane are written, verification of the annotations fails, and both
earlier writes are undone.

## Requested use cases, and what this example does with each

| Requested | Here |
|---|---|
| Classify first-notice reports, adjuster notes and supporting documents | Jev classifies the report. Adjuster notes and attachments are not parsed in this example |
| Detect claim complexity, missing information and potential fraud indicators | Yes/no indicators for missing documents and fraud, asked in the same request as the classification |
| Prioritise claims for straight-through processing or specialist review | A lane label only. **Specialist review is not implemented**, because routing to a person is outside the contract. Straight-through payment is out of scope |
| Escalate uncertain or high-risk cases to a human adjuster | **Not implemented.** A high fraud indicator refuses the automatic setting and leaves the claim untouched |
| Convert reports and notes into probabilistic risk indicators for underwriting | The indicators are stored with the claim as an annotation. Nothing reads them here |

## Claims

**This example may claim:** that claim type can be classified from report text with
indicators asked alongside; that a probe reading the claim history can change the answer;
that a fraud indicator above the threshold blocks the automatic setting; that a failed
annotation write rolls back the earlier writes.

**It must not claim:** that any claim is paid, approved, denied or fraudulent; that a lane
or indicator reflects a real claims process; that the indicators are calibrated or suitable
for underwriting; that a human adjuster would reach a different outcome. Payment is outside
this repository's scope, as [`docs/FSI-BOUNDARIES.md`](../FSI-BOUNDARIES.md) requires.

See [`docs/CLAIM-CONTRACTS.md`](../CLAIM-CONTRACTS.md#examples-09-14--industry-scenarios).
