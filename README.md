# Jev examples

[![check](https://github.com/MSFT-TKENDRICK/JEV-examples/actions/workflows/check.yml/badge.svg)](https://github.com/MSFT-TKENDRICK/JEV-examples/actions/workflows/check.yml)

Runnable TypeScript and Python examples for [Jev](https://docs.typesafe.ai), TypeSafe
AI's System One decision model. Each example calls Jev through the official
[`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk), routed through
[Vercel AI Gateway's TypeSafe-compatible API](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe).
Jev returns a probability distribution over a bounded set of options. The examples
show what application code does with that distribution: it probes for more evidence,
acts reversibly and verifies the result, or refuses and changes nothing.

> Example commands call **live Jev** by default and need a Vercel AI Gateway key.
> Without one they fail with a setup error. They never fall back to simulated answers.
> Scripted fixture runs are available with `npm run all:mock`. Jev is metered on
> Vercel at $0.042 per 1M input tokens (checked 2026-10-08).

## Quick start

Requirements: Node.js 22.18 or later (CI runs Node 24), and a Vercel AI Gateway API
key or `VERCEL_OIDC_TOKEN`. Example 05 also downloads Chrome and ffmpeg through
`webreel` on first use.

```bash
npm ci
cp .env.example .env             # PowerShell: Copy-Item .env.example .env
# Edit .env and set AI_GATEWAY_API_KEY. Leave JEV_MOCK unset for live Jev.
npm run quickstart
```

Without Gateway access, [`local-jev/`](local-jev/README.md) is an opt-in local server
with the same `/v1/systemone` API, backed by the open Laya model. It is **not Jev**.
Set `JEV_BACKEND=local` to point the examples at it. Scripted fixtures are documented
in [`docs/RUNNING.md`](docs/RUNNING.md).

## Examples

| Example | Command | What it shows |
|---|---|---|
| [01 — Quickstart](docs/examples/01-quickstart.md) | `npm run quickstart` | One request with several typed questions; a flat answer selects the next probe |
| [02 — Judge rubrics](docs/examples/02-judge-rubrics.md) | `npm run judge` | A torn verdict decomposes into narrower sub-rubrics |
| [03 — Agent harness](docs/examples/03-agent-harness.md) | `npm run harness` | Probe, reversible action, or refusal; the irreversible step runs last |
| [04 — Browser use](docs/examples/04-browser-use.md) | `npm run browser` | Choosing among a page's own elements, with backtracking |
| [05 — Browser, live](docs/examples/05-browser-live.md) | `npm run record` | The same loop against real Chrome, recorded with `webreel` |
| [06 — Jev vs control](docs/examples/06-jev-vs-control.md) | `npm run compare` | The same maze walked with a distribution and with a single answer |
| [07 — Next step (FSI)](docs/examples/07-next-step.md) | `npm run fsi:07` | Bounded next-step recommendation for card servicing |
| [08 — Runbook routing (FSI)](docs/examples/08-runbook-routing.md) | `npm run fsi:08` | Residual incident routing, with diagnostics chosen by expected information gain |
| [FSI evaluation](docs/examples/fsi-eval.md) | `npm run fsi:eval` | Offline threshold sweep over the 07 and 08 ledgers (fixtures only) |
| [LangChain (Python)](docs/examples/python.md) | `pip install -r examples/python/requirements.txt` | `langchain-typesafe` classifier and middleware |

The index of write-ups is [`docs/examples/README.md`](docs/examples/README.md).

## Commands

| Command | Does |
|---|---|
| `npm run quickstart`, `judge`, `harness`, `browser`, `compare` | Run examples 01–04 and 06 |
| `npm run record` | Run example 05 in Chrome and write `docs/media/browser-use.mp4` |
| `npm run fsi:07`, `fsi:08`, `fsi:eval` | Run the FSI examples and the threshold sweep |
| `npm run all` | Run 01–04, 06, the FSI examples and the sweep against live Jev (excludes 05) |
| `npm run all:mock` | The same suite on scripted fixtures, with no API key. This is what CI runs |
| `npm run local-jev:install`, `local-jev`, `local-jev:parity` | Install, start and check the local Laya proxy (not Jev) |
| `npm run typecheck` | Type-check the TypeScript (Node strips types without checking them) |
| `npm run check` | Typecheck, every offline check suite, the media check and the docs check |

Individual suites are `check:client`, `check:local-jev`, `check:foundation`,
`check:eval`, `check:media` and `check:docs`. Their definitions are in
[`package.json`](package.json).

## Configuration

Copy [`.env.example`](.env.example) to `.env`. The most used variables are:

| Variable | Purpose |
|---|---|
| `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` | Gateway credential. One of the two is required for live Jev |
| `JEV_MOCK=1` | Use scripted fixtures instead of Jev. Set explicitly; never implied |
| `AI_GATEWAY_GENERATIVE=1` | Opt in to live, potentially paid generative models in the TypeScript examples |
| `JEV_BACKEND=local` | Send the same SDK requests to the local Laya proxy. Not Jev |
| `AI_GATEWAY_TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL` | Endpoint and model overrides. Changing the model may change pricing |

A Gateway credential does not enable paid generative models. The full variable list
and the mode rules are in [`docs/RUNNING.md`](docs/RUNNING.md) and
[`docs/SDKS.md`](docs/SDKS.md#repository-configuration).

## Repository layout

```
examples/          Runnable examples: 01–06 (TypeScript), fsi/ (07, 08 and eval), python/, site/
src/               Shared code: client, fixtures, decision policy, ledger, act/verify/compensate runner
local-jev/         Opt-in local proxy with the same wire API, backed by Laya (not Jev)
scripts/           run-examples.ts, media-check.ts, check-docs.ts
docs/              Documentation, including docs/examples/ and docs/media/
.github/workflows/ CI: npm run check and npm run all:mock on Ubuntu and Windows
```

There is no hand-written API client. `@typesafe-ai/sdk` does request building,
literal-typed answers, retries and typed errors, and the AI SDK does structured
generation and Gateway routing. The one hand-written protocol piece,
[`src/mock-fetch.ts`](src/mock-fetch.ts), exists only to answer requests in fixture
runs. It is test infrastructure, not part of the live path.

## Development

- Run `npm ci`, then `npm run check` before opening a change. CI runs the same
  command, followed by `npm run all:mock`.
- `scripts/media-check.ts` requires full git history, so CI checks out with
  `fetch-depth: 0`.
- `scripts/check-docs.ts` verifies every relative link and anchor in `README.md`,
  `local-jev/README.md` and `docs/`. It fails on a broken link and refuses to pass
  if it parsed no links or headings.
- The Python configuration tests run without a model:
  `python -B -m unittest discover -s examples/python -p "test_*.py"`.
- Claims in docs and example output follow [`docs/CLAIM-CONTRACTS.md`](docs/CLAIM-CONTRACTS.md).
  Captured output is labelled as a fixture capture or a live run.

## Documentation

| Document | Covers |
|---|---|
| [`docs/examples/`](docs/examples/README.md) | One write-up per example: what it shows and what it must not claim |
| [`docs/JEV.md`](docs/JEV.md) | What Jev is, what it is not, and the pattern the examples share |
| [`docs/RUNNING.md`](docs/RUNNING.md) | Live and fixture runs, environment, the browser recording and known issues |
| [`docs/SDKS.md`](docs/SDKS.md) | Which SDK and route to use, and the naming differences between APIs |
| [`docs/CLAIM-CONTRACTS.md`](docs/CLAIM-CONTRACTS.md) | What each example may and must not claim |
| [`docs/FSI-BOUNDARIES.md`](docs/FSI-BOUNDARIES.md) | Where this pattern should not be used, and what the repository does not answer |
| [`local-jev/README.md`](local-jev/README.md) | The local Laya proxy: parity coverage, configuration and limits |

## Evidence boundary

The output excerpts and the recording in `docs/` are scripted fixture captures, not
live Jev results. Live runs show that the integration works against synthetic
scenarios. They do not show that Jev is accurate, calibrated, reliable or safe to
automate. The fixtures also manufacture the distributions and the probe costs. They
show what the application does with a distribution, not whether the distribution
deserves trust. No live perturbation results are published here. See
[`docs/FSI-BOUNDARIES.md`](docs/FSI-BOUNDARIES.md) for the full limits.

## Known issues

- **Example 05 video.** `webreel` 0.1.4 requests an ffmpeg build that the upstream
  release no longer publishes under the name it asks for. Set `FFMPEG_PATH` to your
  own ffmpeg. The browser run still happens; only the video is lost. See
  [`docs/RUNNING.md`](docs/RUNNING.md#the-browser-recording-example-05).

## References

- [TypeSafe documentation](https://docs.typesafe.ai)
- [Vercel TypeSafe-compatible API](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)
- [Jev on Vercel AI Gateway](https://vercel.com/ai-gateway/models/jev)
- [Vercel Decision API](https://vercel.com/docs/ai-gateway/modalities/decision)
- [`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk)
- [Vercel AI SDK](https://ai-sdk.dev)
- [`langchain-typesafe`](https://pypi.org/project/langchain-typesafe/) (PyPI, alpha) and
  [`@langchain/typesafe`](https://github.com/langchain-ai/langchainjs/tree/main/libs/providers/langchain-typesafe) (npm)
- [Laya](https://huggingface.co/convaiinnovations/laya), the model behind `local-jev/`

## Contributing

Keep `npm run check` and `npm run all:mock` passing. Do not add a hand-written client
for a service that a published SDK already covers. Write example prose inside the claim
boundaries in [`docs/CLAIM-CONTRACTS.md`](docs/CLAIM-CONTRACTS.md), and update the
write-up in `docs/examples/` when an example's behaviour changes.

## License

This repository does not yet include a license file.
