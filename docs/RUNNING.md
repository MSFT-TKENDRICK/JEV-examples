# Running the examples

This page covers how the examples choose between live Jev and scripted fixtures,
how to configure them, and the known problems with the browser recording. The
README has the short version; the per-example write-ups are in
[`examples/`](examples/README.md).

## Live Jev by default

The npm example scripts load `.env` with Node's `--env-file-if-exists=.env`.

1. Copy [`.env.example`](../.env.example) to `.env`.
2. Set `AI_GATEWAY_API_KEY` (or `VERCEL_OIDC_TOKEN`).
3. Leave `JEV_MOCK` unset.

The shared client sends `typesafe-ai/jev` requests to
`https://ai-gateway.vercel.sh/typesafe`. Without Gateway credentials the examples
fail with a setup error. They do not switch to scripted responses, and they do not
fall back to a direct TypeSafe key or endpoint. See
[`SDKS.md`](SDKS.md#repository-configuration) for every variable the client reads.

Direct `node examples/...` invocations do **not** load `.env`. Either add
`--env-file-if-exists=.env` or export the variables first:

```bash
export AI_GATEWAY_API_KEY=...     # your Vercel AI Gateway key
node examples/01-quickstart.ts
```

## Fixture runs

`npm run all:mock` sets `JEV_MOCK=1` for the whole fixture suite. To run one
example against fixtures, set `JEV_MOCK=1` in your shell and run its command:

```bash
JEV_MOCK=1 npm run quickstart          # PowerShell: $env:JEV_MOCK = '1'; npm run quickstart
```

Unset it before returning to live Jev (PowerShell: `Remove-Item Env:JEV_MOCK`).
`JEV_MOCK=1` overrides a configured Gateway credential. The threshold sweep
(`npm run fsi:eval`) and the fault-injection checks always run on fixtures, and
do not measure live Jev.

In fixture mode the examples inject a mock `fetch` into the real `TypeSafeClient`
([`src/mock-fetch.ts`](../src/mock-fetch.ts)). The SDK's request building and error
handling still run. Only the HTTP responses are manufactured.

Live FSI service failures and unusable answers fail closed, keep the refusal
ledger, and exit nonzero. A valid model abstention is not a service failure.
Expected injected failures in fixture runs keep a successful exit.

## What the fixtures do and do not establish

- The mock matches the response declarations published in `@typesafe-ai/sdk`
  field for field. Version 0.6.0 is the one this repository pins. Its response
  declarations are unchanged from 0.5.7, but the score criteria rules changed (see
  [`SDKS.md`](SDKS.md#1-typesafe-aisdk-through-vercel--what-this-repo-uses)).
  It preserves the invariants that matter: distributions sum to 1, a Score is the
  probability-weighted mean of its levels, and a Choice is the argmax.
- The SDK does **not** runtime-validate responses. It parses JSON and returns it.
  The mock's fidelity rests on its TypeScript types and on review, not on the SDK
  rejecting a wrong shape. It has never been checked against a captured live
  response, so "matches the published types" is the strongest claim available.
- The mock approximates confidence as `1 - normalizedEntropy`. For example, an
  83/17 split reports 34.2%. This is an authored heuristic, not a measurement of
  Jev's confidence semantics or calibration. Do not port the formula as a
  calibration rule.
- Score targets are hit to within about 0.002 rather than exactly, because the mock
  caps its peak mass at 0.999 and rounds the emitted distribution.

## The generative half

The proposer, triager and generative browser control default to **disclosed
scripted replay**. Supplying the Gateway credential needed for Jev does not enable
paid generation. Only `AI_GATEWAY_GENERATIVE=1` opts the TypeScript proposer,
triager and control into live Gateway generation, and those models can incur
charges. A live Jev run alone is not a live generative-model comparison.
`JEV_MOCK=1` forces these arms back to fixtures even when generation is opted in.

The Python integration has its own separate switch. See
[`examples/python.md`](examples/python.md).

## The browser recording (example 05)

Example 05 uses [`webreel`](https://www.npmjs.com/package/webreel), which downloads
Chrome and ffmpeg into `~/.webreel` on first use. `npm run all` runs 01–04, 06 and
the FSI examples, and leaves out 05.

```bash
npm run record                 # record to docs/media/browser-use.mp4
npm run record -- --no-video   # drive the browser, skip the recording
```

The committed recording uses fixture responses. To regenerate it without Gateway
credentials, run `JEV_MOCK=1 npm run record`. The recording shows browser
execution under scripted decisions, not hosted Jev inference.

If `ffmpeg` cannot be obtained, the example says so and keeps going. You lose the
video, not the result.

> **Known upstream issues (checked 2026-10-08).**
>
> - webreel 0.1.4, the latest release on npm, requests an ffmpeg build named
>   `ffmpeg-n7.1-latest-…` from `BtbN/FFmpeg-Builds`. That asset returns 404.
>   BtbN now publishes `n8.1` and `n9.0` builds, but webreel still asks for `n7.1`.
>   Set `FFMPEG_PATH` to your own ffmpeg binary. The browser loop runs either way,
>   and only the video is lost.
> - webreel's headless launch flags include `--enable-begin-frame-control`, which
>   stalls `Page.captureScreenshot` indefinitely, so its own recorder captures no
>   frames. [`src/chrome-launch.ts`](../src/chrome-launch.ts) starts the same binary
>   without those two flags and explains why.

Recording runs at 20 fps rather than webreel's default 60. The recorder caps
duplicate frames at three, so a mostly static page would otherwise play back fast.

## PowerShell

PowerShell does not accept the POSIX environment-variable prefix form:

| Task | PowerShell |
|---|---|
| Create `.env` | `Copy-Item .env.example .env` |
| Set a variable for one session | `$env:JEV_MOCK = '1'` |
| Clear it | `Remove-Item Env:JEV_MOCK` |
