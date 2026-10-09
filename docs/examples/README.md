# Examples

Each runnable example has a write-up here. The write-up says what the example
shows, what it may be read as showing, and what it must not be read as showing.
The claim boundaries they follow are in [`../CLAIM-CONTRACTS.md`](../CLAIM-CONTRACTS.md)
and [`../FSI-BOUNDARIES.md`](../FSI-BOUNDARIES.md).

| Example | Command | Write-up |
|---|---|---|
| 01 — Quickstart | `npm run quickstart` | [01-quickstart.md](01-quickstart.md): one request with several typed questions; a flat answer selects the next probe |
| 02 — Judge rubrics | `npm run judge` | [02-judge-rubrics.md](02-judge-rubrics.md): a torn verdict decomposes into narrower sub-rubrics |
| 03 — Agent harness | `npm run harness` | [03-agent-harness.md](03-agent-harness.md): probe, reversible act, or refuse; the irreversible step runs last |
| 04 — Browser use | `npm run browser` | [04-browser-use.md](04-browser-use.md): choosing among a page's own elements, with backtracking. Runs in memory and opens no browser |
| 05 — Browser, live | `npm run record -- --no-video` | [05-browser-live.md](05-browser-live.md): the same loop in a real Chrome window, or recorded with webreel |
| 06 — Jev vs control | `npm run compare` | [06-jev-vs-control.md](06-jev-vs-control.md): the same maze walked with a distribution and with a single answer |
| 07 — Card servicing (FSI) | `npm run fsi:card-servicing` | [07-card-servicing.md](07-card-servicing.md): bounded next-step selection for card servicing, with verified rollback |
| 08 — Runbook routing (FSI) | `npm run fsi:runbook-routing` | [08-runbook-routing.md](08-runbook-routing.md): residual incident routing; diagnostics chosen by expected information gain |
| 09 — Fraud and AML alerts (FSI) | `npm run fsi:fraud-alerts` | [09-fraud-alerts.md](09-fraud-alerts.md): typology and priority for alerts, with KYC checks; nothing is closed |
| 10 — Insurance claims (FSI) | `npm run fsi:insurance-claims` | [10-insurance-claims.md](10-insurance-claims.md): claim type, lane and risk indicators; nothing is paid |
| 11 — Content safety (FSI) | `npm run fsi:content-safety` | [11-content-safety.md](11-content-safety.md): deterministic rules before a clause choice; reversible visibility limits |
| 12 — Compliance audit (FSI) | `npm run fsi:compliance-audit` | [12-compliance-audit.md](12-compliance-audit.md): evidence fields read deterministically, rubric ratings, and a draft assessment |
| 13 — Semantic signals (FSI) | `npm run fsi:semantic-signals` | [13-semantic-signals.md](13-semantic-signals.md): intent features, knowledge-graph relations, and a gated two-step entity classification |
| 14 — Search reranking (FSI) | `npm run fsi:search-rerank` | [14-search-rerank.md](14-search-rerank.md): rules remove ineligible results, then a bounded choice reranks the rest |
| FSI evaluation | `npm run fsi:eval` | [fsi-eval.md](fsi-eval.md): an offline threshold sweep over the 07 and 08 ledgers |
| LangChain (Python) | `npm run python:install`, then `npm run example -- examples/python/judge_rubric.py` | [python.md](python.md): `langchain-typesafe` classifier and middleware |

## Reading the output

- The commands call **live Jev** through Vercel AI Gateway when `AI_GATEWAY_API_KEY`
  or `VERCEL_OIDC_TOKEN` is set. With no key, the npm example commands run on the local
  Laya proxy and say so. Use `--backend=gateway|local|mock` to choose explicitly.
- Output blocks in these write-ups are **captures from scripted fixture runs**
  (`JEV_MOCK=1`) unless a write-up says otherwise. A live run can reach different
  decisions on the same synthetic scenario. Neither is evidence of model quality.
- Captures were taken with `NO_COLOR=1`, so no escape codes appear in the Markdown.

## Writing an example write-up

- Start with a `#` title that names the example and its one-line claim.
- Link to the example file and give the command that runs it.
- Include what the example may be read as showing and what it must not be read as
  showing, or link to [`../CLAIM-CONTRACTS.md`](../CLAIM-CONTRACTS.md).
- State the fixture constraint explicitly. Distinguish the live default command
  from explicit `JEV_MOCK=1` captures. A Gateway credential alone must not be
  described as enabling paid generative models; those require `AI_GATEWAY_GENERATIVE=1`.
- Show real output from a real run, labelled as a fixture capture or a live run.
- Do not describe uncertainty as being routed to a person. No example does that.
  Uncertainty selects a probe, a reversible action, or a refusal.

## The FSI examples

Examples 07 and 08 write a JSONL decision ledger, and the evaluation harness reads
those ledgers. Examples 09 to 14 share one decision loop
([`src/decision-loop.ts`](../../src/decision-loop.ts)) and print a trace and a
summary. They do not write a ledger. Across the FSI examples, each run identifies its
live or scripted mode, and no example claims that a distribution deserves trust. They
show what the surrounding application does with one.

```bash
npm run fsi:card-servicing
npm run fsi:runbook-routing
npm run fsi:fraud-alerts
npm run fsi:insurance-claims
npm run fsi:content-safety
npm run fsi:compliance-audit
npm run fsi:semantic-signals
npm run fsi:search-rerank
npm run fsi:eval
```

`npm run check:fsi-examples` runs examples 09 to 14 against their fixtures in process
and checks each scenario against the outcome it declares.
