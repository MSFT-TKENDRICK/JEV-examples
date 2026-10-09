# 14 — Search reranking: deterministic eligibility first, then a bounded choice

[`examples/fsi/14-search-rerank/index.ts`](../../examples/fsi/14-search-rerank/index.ts) — run with `npm run fsi:search-rerank`.

Retrieved documents are filtered by rules before any model call: jurisdiction and product
must match the query. Jev then chooses, from the eligible documents, the one that answers
the question. When the choice is flat, a probe reads which edition of the policy is
current. The chosen document is ranked first by a reversible write, and that write is
verified by reading the list back.

**Fixture constraint.** The output is from `JEV_MOCK=1`. The documents and the
edition record are authored. The ranking is a field on an in-memory record, not a
search index.

## Captured output (fixture run)

```
  rules removed 1 result(s) before the model: DOC-OD-US
Summary
  Q-101                    completed    DOC-OD-2026                  1 probe(s), cost 1 · probe changed the answer
  Q-102                    completed    DOC-OD-FEES                  no probe
  Q-103                    refused      DOC-OD-2019                  no probe
```

The US edition is removed by the rule, so Jev never sees it. Q-101 starts flat between the
2019 edition and the 2026 edition. The version probe reads that 2026 is current, and Jev
moves to it at 82%. Q-102 is confident from the start. Q-103 is flat and has no budget for
the probe, so the ranking is left as it was.

## Requested use cases, and what this example does with each

| Requested | Here |
|---|---|
| Search, retrieval and reranking | Rules filter the retrieved set, Jev chooses among the eligible, and the chosen result is ranked first |
| Rules engine routing | Jurisdiction and product rules decide which results reach the model |
| Semantic relevance | Jev's choice among eligible documents |

## Claims

**This example may claim:** that ineligible results never reach the model; that a flat
choice can be settled by reading which edition is current; that a rank written to the list
is verified; that a run that cannot decide leaves the list as it was.

**It must not claim:** that the first-ranked document answers the customer's question
correctly; that retrieval recall is adequate; that the ranking improves any search quality
measure. The documents, rules and editions are illustrative.

See [`docs/CLAIM-CONTRACTS.md`](../CLAIM-CONTRACTS.md#examples-09-14--industry-scenarios).
