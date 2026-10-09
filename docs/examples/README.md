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
| 04 — Browser use | `npm run browser` | [04-browser-use.md](04-browser-use.md): choosing among a page's own elements, with backtracking |
| 05 — Browser, live | `npm run record` | [05-browser-live.md](05-browser-live.md): the same loop against real Chrome, recorded with webreel |
| 06 — Jev vs control | `npm run compare` | [06-jev-vs-control.md](06-jev-vs-control.md): the same maze walked with a distribution and with a single answer |
| 07 — Next step (FSI) | `npm run fsi:07` | [07-next-step.md](07-next-step.md): bounded next-step recommendation for card servicing |
| 08 — Runbook routing (FSI) | `npm run fsi:08` | [08-runbook-routing.md](08-runbook-routing.md): residual incident routing; diagnostics chosen by expected information gain |
| FSI evaluation | `npm run fsi:eval` | [fsi-eval.md](fsi-eval.md): an offline threshold sweep over the 07 and 08 ledgers |
| LangChain (Python) | `pip install -r examples/python/requirements.txt` | [python.md](python.md): `langchain-typesafe` classifier and middleware |

## Reading the output

- The commands call **live Jev** through Vercel AI Gateway by default. They need
  `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`, and fail without one.
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

Examples 07 and 08 and the evaluation harness are written to a stricter standard
than examples 01–06. Every decision is written to a JSONL ledger, each run
identifies its live or scripted mode, and no example claims that a distribution
deserves trust. They show what the surrounding application does with one.

```bash
npm run fsi:07
npm run fsi:08
npm run fsi:eval
```
