# 09 — Fraud triage: alerts, transactions and customer reports

[`examples/fsi/09-fraud-alerts/index.ts`](../../examples/fsi/09-fraud-alerts/index.ts) — run with `npm run fsi:fraud-alerts`.

One bounded decision, three uses. Alerts get a typology and a priority, with probes that read KYC, the device history and the alert history when the answer is flat. A transaction is judged twice with one field changed, and the distribution moves with it. A customer report is classified by intent in one request, with yes/no signals for risk and for the servicing tools the next step needs. The tools that pass are written as a shortlist, and none is run. Every write is a reversible field. Nothing is closed, cleared, approved, held, or routed to a person.

**Fixture constraint.** The output is from `JEV_MOCK=1`. The alerts, transactions, KYC records and probe partitions are authored. Live Jev can choose different typologies on the same input. Without a Gateway key the npm command uses the local Laya proxy, which is not Jev.

## Captured output (fixture run)

```
Summary
  ALERT-2201               completed    mule_account                 1 probe(s), cost 1 · probe changed the answer
  ALERT-2207               refused      structuring                  2 probe(s), cost 3
  ALERT-2212               completed    legitimate_pattern           no probe
  ALERT-2219               refused      legitimate_pattern           no probe
  ALERT-2231               refused      mule_account                 no probe
  ALERT-2232               completed    mule_account                 no probe
  TXN-884                  completed    account_takeover             1 probe(s), cost 2 · probe changed the answer
  TXN-884b                 refused      structuring                  1 probe(s), cost 2
  REPORT-7720              completed    fraud_report                 no probe
  shortlist written: get_transactions, lock_account, initiate_fraud_case (not run)

Priority order (items not completed keep their existing position)
  ALERT-2201   high       mule_account         1 probe(s)  completed
  TXN-884      high       account_takeover     1 probe(s)  completed
  ALERT-2232   high       mule_account         0 probe(s)  completed
  REPORT-7720  high       fraud_report         0 probe(s)  completed
  ALERT-2212   standard   legitimate_pattern   0 probe(s)  completed
  ALERT-2207   unchanged  —                    2 probe(s)  refused
  TXN-884b     unchanged  —                    1 probe(s)  refused
  ALERT-2219   unchanged  —                    0 probe(s)  refused
  ALERT-2231   unchanged  —                    0 probe(s)  refused
```

**What-if.** TXN-884 has an unknown device. The device probe reads that, and Jev moves
the distribution to account takeover at 72%, which is acted on. TXN-884b is the same
transaction with a known device. The distribution moves to structuring at 60%, and the
run does not act: the leader is not confident enough, and the probe budget for this
decision is spent.

**Same winner, different confidence.** ALERT-2231 and ALERT-2232 both lead with mule
account. At 46% the margin is too small to act on, and the run refuses. At 96% it acts.

**Customer report.** REPORT-7720 needs one request with three kinds of answer: an intent
choice (fraud report at 90%), a high-risk signal (91%), and a yes/no signal per servicing
tool. The tools at 50% or above are written as a shortlist: transaction history, lock the
account, and open a fraud case. The profile lookup, at 41%, is not shortlisted. Mortgage and
investment tools are below 1%. The shortlist is written and not executed.

## The brief, item by item

| Item in the brief | What happened to it |
|---|---|
| 1. Transaction fraud triage, returning APPROVE, CHALLENGE, HOLD or ESCALATE | **Integrated as the what-if** (TXN-884 and TXN-884b): one field changed, distribution moved, decision with stated refusal. **APPROVE, CHALLENGE and HOLD are not offered**: they decide what a principal may do, which [`FSI-BOUNDARIES.md`](../FSI-BOUNDARIES.md) prohibits. **ESCALATE is not offered**: it routes to a person. The example prioritises; it does not dispose. |
| 2. AML and KYC routing: NO_ACTION, REQUEST_INFORMATION, EDD_REVIEW, AML_ANALYST, SANCTIONS_REVIEW | **Integrated as the confidence pair** (ALERT-2231 and ALERT-2232): same winner, different mass, different outcome. **AML_ANALYST, EDD_REVIEW and SANCTIONS_REVIEW are not offered** (people, and review routes). **Automatic routing above 0.90 is not adopted.** The brief's three bands (above 0.90, 0.65 to 0.90, below 0.65) were marked as demo policy; this repository keeps its own thresholds (0.70 leader, 0.25 margin, 0.60 normalised entropy). |
| 3. Loan and mortgage processing path | **Not integrated.** MANUAL_UNDERWRITING and FRAUD_REVIEW route to people. Sensitivity to LTV and DTI is underwriting, which [`FSI-BOUNDARIES.md`](../FSI-BOUNDARIES.md) prohibits. Document completeness, the machine part of that path, is covered by the claims checklist in [example 10](10-insurance-claims.md). |
| 4. Agentic tool selection | **Integrated into the customer report.** Each tool is a yes/no signal, because tools are not mutually exclusive, and the passing tools are written as a shortlist. The handoff to a reasoning agent is **not built**. |
| 5. Insurance claims triage | **Integrated into [example 10](10-insurance-claims.md)** as the auto-claim case. STRAIGHT_THROUGH maps to a standard lane label, and nothing is paid. REQUEST_EVIDENCE maps to a pending-documents lane. ADJUSTER_REVIEW, SIU_REVIEW and TOTAL_LOSS_REVIEW are not offered. |
| 6. Code and DevSecOps policy routing | **Not integrated.** It sits outside the FSI scope, and its routes are reviews. |
| Real-time fraud servicing, combining 1 and 4 | **Integrated as the customer report.** The customer's words are classified, risk and tool signals are asked in the same request, and a shortlist is written. No card is frozen and no tool is run. |
| Same model on 0.8B, 2B, 4B and Laya, with latency and agreement | **Not built.** Only Laya is installed on this machine, and the Intern-Decision models are not in the repository. A four-model comparison needs those models. |
| Cascade: confident goes to action, uncertain goes to a frontier model, still uncertain goes to a human | **Not built.** The frontier step would be a paid generative call, and the human step is banned by the architecture contract. |

## Claims

**This example may claim:** that a probe on a record can change the leader, and that a
changed field moves the distribution; that two leaders with the same name can differ in
confidence, and only the confident one is acted on; that a deterministic check can refuse
a confident answer; that several yes/no signals asked in one request can drive a written
shortlist.

**It must not claim:** that any transaction is fraudulent, safe, approved or held; that any
alert is closed or cleared; that any tool was run; that a reasoning model was consulted;
that the probabilities are calibrated; that the tool signals are accurate. Nothing here is
an authorisation decision.

See [`docs/CLAIM-CONTRACTS.md`](../CLAIM-CONTRACTS.md#examples-09-14--industry-scenarios).
