# 13 — Semantic signals: forecasting features and knowledge-graph annotation

[`examples/fsi/13-semantic-signals/index.ts`](../../examples/fsi/13-semantic-signals/index.ts) — run with `npm run fsi:semantic-signals`.

Two uses of the same bounded decision. Customer inquiries are classified by intent, with
yes/no signals for urgency, supply concern and competitor mention. The result is a feature
row. Knowledge-graph edges are classified by relation, and a contradiction signal stops a
merge. Entity types are refined in two steps: the second step is gated on the first
returning an organisation, and a licence-register probe settles its kind. Everything written
is a reversible field, and no forecast is produced.

**Fixture constraint.** The output is from `JEV_MOCK=1`. The inquiries, relations and
register entries are authored. Staged edges and feature rows are fields on in-memory
records, not writes to a model or a graph store.

## Captured output (fixture run)

```
Summary
  INQ-7001                 completed    buy_now                      no probe
  INQ-7002                 completed    research                     1 probe(s), cost 1 · probe changed the answer
  INQ-7003                 refused      research                     no probe
  KG-REL-42                refused      same_entity_variant          no probe
  KG-REL-47                completed    subsidiary_of                no probe
  KG-ENT-51-type           completed    organisation                 no probe
  KG-ENT-51-kind           completed    bank                         1 probe(s), cost 1 · probe changed the answer
```

INQ-7002 starts flat between buy now and research. The catalogue probe reads that a
competitor is named, and Jev moves to research at 80%. KG-REL-42 is confident that the two
names are one entity, but the records contradict each other, so the gate refuses the merge.
KG-ENT-51-kind starts flat, the licence register says the entity is a bank, and Jev settles on bank.

## Requested use cases, and what this example does with each

| Requested | Here |
|---|---|
| Extract purchase intent, urgency and product interest | Intent is the choice. Urgency and competitor mention are yes/no signals. Product interest is not separated from intent |
| Detect supply concerns, competitive pressure and emerging demand themes | Supply concern and competitor mention are signals. Emerging themes across inquiries are not aggregated |
| Feed those features into a forecasting model alongside time-series data | **Not done.** The example writes feature fields and forecasts nothing |
| Classify relationships and entity types | Relation classification between two records, and a two-step entity type and kind |
| Detect contradictions between records or claims | A contradiction signal gates the merge of two records |
| Support probabilistic traversal and hierarchical classification | The kind step runs only after the type step has written an organisation |

## Claims

**This example may claim:** that an inquiry can be classified with signals asked alongside;
that a probe can change the intent; that a contradiction signal stops a confident merge; that
a second classification step can be gated on the first.

**It must not claim:** that any feature predicts demand; that any relation is true; that two
records describe one entity when they do not; that staged edges are correct. Nothing is
written to a production graph.

See [`docs/CLAIM-CONTRACTS.md`](../CLAIM-CONTRACTS.md#examples-09-14--industry-scenarios).
