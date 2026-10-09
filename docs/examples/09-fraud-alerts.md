# 09 — Fraud and AML alert prioritisation

[`examples/fsi/09-fraud-alerts/index.ts`](../../examples/fsi/09-fraud-alerts/index.ts) — run with `npm run fsi:fraud-alerts`.

Jev chooses a typology for each alert from a bounded list. When the answer is flat,
read-only probes check the payee names against KYC, the device history and the alert
history. A deterministic gate refuses a "legitimate pattern" label that KYC does not
support. Accepted alerts get a typology and a priority, both reversible. The example
never closes, clears or reports an alert.

**Fixture constraint.** The output below is from `JEV_MOCK=1`. The alerts, KYC records
and probe partitions are authored. Live Jev can choose different typologies on the same
alerts. Without a Gateway key the npm command uses the local Laya proxy, which is not Jev.

## Captured output (fixture run)

```
Summary
  ALERT-2201               completed    mule_account                 1 probe(s), cost 1 · probe changed the answer
  ALERT-2207               refused      structuring                  2 probe(s), cost 3
  ALERT-2212               completed    legitimate_pattern           no probe
  ALERT-2219               refused      legitimate_pattern           no probe

Priority order (alerts not completed keep their existing position)
  ALERT-2201   high       mule_account         1 probe(s)  completed
  ALERT-2212   standard   legitimate_pattern   0 probe(s)  completed
  ALERT-2207   unchanged  —                    2 probe(s)  refused
  ALERT-2219   unchanged  —                    0 probe(s)  refused
```

ALERT-2201 starts flat between structuring and mule accounts. The payee-name probe
reads "none" and Jev moves to mule account at 74%, which is the flip. ALERT-2207 stays
flat through its probes, so the budget runs out and nothing is written. ALERT-2219 is
confident, but the KYC record does not declare the counterparty, so the gate refuses.

## Requested use cases, and what this example does with each

| Requested | Here |
|---|---|
| Evaluate narratives, KYC documents and alert histories for suspicious characteristics | Jev classifies the narrative. The KYC and history checks are probes |
| Match entities across inconsistent names, profiles and records | A three-way name match (exact, variant, none) against declared counterparties. This is not entity resolution |
| Prioritise alerts by risk, relevance and evidence quality | A high or standard priority band per typology, and the completed queue ordered by evidence gathered |
| Route ambiguous cases to investigators for review | **Not implemented.** The architecture contract forbids routing uncertainty to a person. An ambiguous alert is refused and left as it was |

## Claims

**This example may claim:** that a probe which reads a record can change the leader and
be acted on; that a flat distribution with a spent budget leaves the alert unchanged;
that a deterministic check on the record can refuse a confident answer; that the
priority order is a function of the typology and the evidence count.

**It must not claim:** that any alert is correct, suspicious, closed, cleared or
reported; that a typology is a regulatory category; that the probability is calibrated;
that the payee matching is entity resolution; that the fixtures reflect real alert
populations. Nothing in this example disposes of an alert, consistent with
[`docs/FSI-BOUNDARIES.md`](../FSI-BOUNDARIES.md).

See [`docs/CLAIM-CONTRACTS.md`](../CLAIM-CONTRACTS.md#examples-09-14--industry-scenarios).
