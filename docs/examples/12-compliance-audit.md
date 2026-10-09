# 12 — Compliance audit: rubric scoring of control evidence, then a draft assessment

[`examples/fsi/12-compliance-audit/index.ts`](../../examples/fsi/12-compliance-audit/index.ts) — run with `npm run fsi:compliance-audit`.

A deterministic parser reads the `Label: value` lines of each evidence document, so a
review date or a sample size is read, not guessed. Jev rates each control as meets,
partially meets, or fails. When the rating is flat, a probe reads the change sample. A
gate refuses evidence more than 90 days old. Accepted ratings are recorded as draft
findings, and an assessment draft is built from them with a template. The draft is not
published.

**Fixture constraint.** The output is from `JEV_MOCK=1`. The evidence documents, dates
and samples are authored. The assessment wording is a template: **this example does not
call a generative model to write the narrative**. A generative writer could replace
`draftAssessment` without changing the decision code, but none is wired here.

## Captured output (fixture run)

```
Summary
  AC-REVIEW                completed    meets                        no probe
  CHG-APPROVAL             completed    fails                        1 probe(s), cost 1 · probe changed the answer
  BACKUP-RESTORE           refused      partially_meets              no probe
  PRIV-ACCESS              refused      meets                        no probe

Assessment draft, audit date 2026-10-08 (DRAFT: not published)
- AC-REVIEW: finding: meets
- CHG-APPROVAL: finding: fails
- BACKUP-RESTORE: no finding recorded (no affordable probe left: 0 of 0 budget left, and the cheapest unspent probe costs 1)
- PRIV-ACCESS: no finding recorded (gate: the evidence is 220 days old; the limit is 90)
Sending this draft to the auditee is not automated.
```

CHG-APPROVAL is flat between partially meets and fails. Six unapproved changes are in the
sample, the probe reads them, and Jev moves to fails at 84%. BACKUP-RESTORE has no budget
for the probe that would read its evidence file, so it is refused. PRIV-ACCESS is confident,
but its evidence is 220 days old and the gate refuses it.

## Requested use cases, and what this example does with each

| Requested | Here |
|---|---|
| Compliance audit assessments: a scoring rubric detects failures | Each control is rated against a three-level rubric, and failures are a rating |
| Then an LLM writes the assessment | **Templated, not generative.** The draft lists each finding or the reason for none. See the constraint above |
| Feature extraction from forms and documents | A deterministic parser reads `Label: value` lines. It does not parse free text, scans or tables |

## Claims

**This example may claim:** that fields can be read from evidence lines and used by a
gate; that a flat rating can be settled by a read of the sample; that evidence older than
the limit is not recorded; that the draft lists what was and was not decided.

**It must not claim:** that any control is effective or ineffective; that a sample is
representative; that the draft is an audit opinion; that the wording was produced by a
language model. The draft is not sent to an auditee, because that is not automated.

See [`docs/CLAIM-CONTRACTS.md`](../CLAIM-CONTRACTS.md#examples-09-14--industry-scenarios).
