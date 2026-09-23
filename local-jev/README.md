# Local Jev-compatible proxy (Laya, not Jev)

An opt-in local server with the TypeSafe `systemOne` API, for when you cannot
reach Jev through Vercel AI Gateway. It serves `POST /v1/systemone`,
`GET /v1/models` and `GET /health` on loopback. The examples talk to it through
the same `@typesafe-ai/sdk` client they use for Jev.

**This is not Jev.** The model behind it is
[Laya](https://huggingface.co/convaiinnovations/laya), an open decision model
with native choice / score / noul heads. It runs through the
[`@receptron/laya`](https://github.com/receptron/laya) package on ONNX Runtime
CPU, with no Python. Every response, banner and ledger record names it:

- `model` is `local-laya/laya-onnx-fp32@68f27df`;
- the run mode is `LOCAL_MODEL`;
- `/health` reports `"jev": false`.

Nothing here measures how closely Laya's answers track Jev's.

```bash
npm run local-jev:install            # once; see "Install" if the registry lacks the package
npm run local-jev                    # first start downloads the 1.7 GB bundle to ~/.cache/receptron-laya
JEV_BACKEND=local npm run quickstart # PowerShell: $env:JEV_BACKEND='local'; npm run quickstart
npm run local-jev:parity             # reference + wire checks against the real model
```

## What "parity" covers

| Covered | How it is checked |
|---|---|
| Wire format: request validation, answer shapes, `legend`, `usage`, error bodies the SDK can read (400/404/405/413/422/502) | `npm run check:local-jev` (CI, with a scripted engine) |
| Laya's reference output through proxy + SDK. The package's Python-reference case is reproduced to 4 decimals: `input_tokens` 267, billing 0.9415, urgency 1.3886, churn 0.0988 | `npm run local-jev:parity` |
| Invariants: probabilities sum to 1, `choice` is the argmax, `score` is the expected level, confidence and noul lie in [0, 1] | `npm run local-jev:parity` |
| Every example completes with `JEV_BACKEND=local` | run manually; see below |
| **Not covered: agreement with Jev's answers or calibration** | no Gateway measurement exists here |

The proxy translates only where the two APIs differ, in `protocol.ts`:

- Structured descriptions and levels are passed to Laya as JSON text.
- Laya's `rl_agent` field is stripped from answers.
- `legend` is rebuilt from the caller's own criteria.
- If Laya returns labels that were not asked for, the proxy returns 502 rather
  than a wrong answer.

## Why this model, at this precision

- **Laya is the only candidate that runs here and fits the API.** It answers
  choice, score and noul natively, and ships an ONNX export with an npm runtime.
- **Decider-0.8B and Kev-0.8B were ruled out.** They are larger and need PyTorch,
  which has no Windows ARM64 wheels, so they could not run on the machine this
  was built on.
- **FP32 is the smallest build that reproduces the reference.** On a Snapdragon
  X Elite (ARM64, CPU only), the package's own reference test passes 8/8.
- **INT8 was rejected for drift.** Dynamic quantization was 2.9× smaller and
  1.8× faster (581 MB, ~333 ms), but its answers moved too far:

  | Benchmark question | FP32 | INT8 |
  |---|---|---|
  | billing | 0.4768 | 0.755 |
  | urgency | 1.1576 | 0.6392 |
  | churn | 0.0089 | 0.147 |

  That is not parity, so the bundle is FP32. It is pinned to
  `receptron/laya-onnx@68f27dfe5a27a54fb2b1fefc432f43f972e90868`.

## Input longer than Laya was trained on

Laya was trained on sequences of 512 tokens, with 192 of them for the question
(its instructions plus options). Laya on its own **silently truncates** anything
longer. The proxy checks every request with the package's own sequence builder
before running it, then applies `LOCAL_JEV_OVERFLOW`:

| `LOCAL_JEV_OVERFLOW` | Behaviour | `x-local-jev-overflow` |
|---|---|---|
| `extend` (default) | Accept the request as Jev would. Run it at the length it needs, up to the ModernBERT encoder's 8,192 positions, so no input is dropped. Answers on such input are outside Laya's training length. | `extended` |
| `reject` | Return 422 and name what would be cut, so every answer comes from in-distribution input | — |
| `truncate` | Laya's native behaviour: answer from whatever fits | `truncated` |

Two limits apply in every mode. A request longer than 8,192 tokens is refused
with 422. So is an option longer than 48 tokens, because the package hard-codes
that per-option cap. Every answer also carries an `x-local-jev-context` header,
`<total>/<question>`, giving the limits it ran at.

In a local run of the examples:

- 01, 02, 04 and 06 fit Laya's trained limits.
- 03, 07 and 08 exceed them. Their option lists take 193–241 question tokens,
  and some incident states are over 600 tokens. With the default `extend` they
  run at up to 1,029/288 tokens.
- Most cases end in refusal. On Laya's answers, the refusal gates in 03, 07 and
  08 decline to act on most of their cases.

## Measured cost

These figures are for a Snapdragon X Elite X1E80100 (12 cores, ARM64), on ONNX
Runtime CPU with its default thread count. Setting 4, 8 or 12 threads was
slower.

| | Measured |
|---|---|
| Warm load | 3–4 s. The first start also downloads the 1.7 GB bundle. |
| 3 questions, ~180 tokens, idle machine | ~600 ms p50 (507 ms minimum) |
| Resident memory | ~1.7 GB at the trained length; ~3.0 GB after an 1,831-token request |
| Examples, 4–5 questions of 600–1,800 tokens, on a machine at 100% CPU from other work | 3–30 s per request |

The proxy runs one request at a time. The examples' client uses a 120 s timeout
for this backend, set by `LOCAL_JEV_TIMEOUT_MS`.

## Configuration

| Variable | Default | Read by |
|---|---|---|
| `JEV_BACKEND` | `gateway` | examples. Set it to `local` to use this proxy. |
| `LOCAL_JEV_URL` | `http://127.0.0.1:8765` | examples |
| `LOCAL_JEV_TIMEOUT_MS` | `120000` | examples |
| `LOCAL_JEV_HOST` / `LOCAL_JEV_PORT` | `127.0.0.1` / `8765` | proxy |
| `LOCAL_JEV_OVERFLOW` | `extend` | proxy |
| `LOCAL_JEV_MODEL_DIR` | — | proxy. An exported Laya ONNX bundle to use instead of downloading. |
| `LOCAL_JEV_REVISION` | pinned commit | proxy |
| `LOCAL_JEV_THREADS` | runtime default | proxy |

The Python helper `examples/python/jev_gateway.py` also honours
`JEV_BACKEND=local` and `LOCAL_JEV_URL`. Only its configuration is unit-tested:
`langchain-typesafe` was not installable where this was built, so no Python
request has been run against the proxy.

## Install

`local-jev/` is a separate package with no lockfile. That keeps
`onnxruntime-node` and the model out of the root dependency graph and out of
CI. `npm run local-jev:install` installs `@receptron/laya@0.1.2` from your
registry.

If your registry does not carry the package yet, build it from the tagged
source, then install the tarball:

```bash
git clone --depth 1 --branch v0.1.2 https://github.com/receptron/laya "$TMPDIR/receptron-laya"
cd "$TMPDIR/receptron-laya" && rm -f yarn.lock && npm install && npm run build && npm pack
cd - && npm install --prefix local-jev --no-save --no-package-lock "$TMPDIR/receptron-laya/receptron-laya-0.1.2.tgz" @huggingface/tokenizers@^0.2.0
```

## Files

| File | Role |
|---|---|
| `protocol.ts` | Request validation and TypeSafe ↔ Laya translation |
| `app.ts` | HTTP routes, overflow policy, error shapes; the engine is injected |
| `engine.ts` | Loads Laya, and runs the exact truncation check against the package's `buildSequence` |
| `main.ts` | CLI and `startLocalJev()` |
| `app.check.ts` | CI contract tests through the real SDK, with a scripted engine |
| `parity.ts` | Real-model reference, invariant, limit and latency checks |
