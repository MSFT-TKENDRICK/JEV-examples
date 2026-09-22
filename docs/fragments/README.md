# README fragments

Each example writes its README section here instead of editing `README.md`.

## Why

The examples are built in parallel, in separate git worktrees, by separate
sessions. If several edited `README.md` the merge conflict would be guaranteed —
same file, adjacent sections, no shared history between the branches until they
land. The same applies to `package.json`.

So the rule is: **a child session never edits `README.md` or `package.json`.** It
writes `docs/fragments/<nn>.md`, and the integration phase assembles the fragments
into `README.md` once the examples have merged.

If an example needs a new npm script, it says so in its pull request description
rather than adding one. The script is wired centrally at integration.

## Contract for a fragment

- Start at heading level `###`, matching the existing per-example sections in
  `README.md`.
- Open with a link to the example file and a one-line statement of what it shows.
- Include the example's allowed-claims / must-not-claim summary, or link to
  [`docs/CLAIM-CONTRACTS.md`](../CLAIM-CONTRACTS.md).
- State the scripted-fixture constraint explicitly. Do not rely on the reader
  having seen it elsewhere in the README.
- Show real output from a real run, not illustrative output. Capture it with
  `NO_COLOR=1` so the escape codes do not end up in the markdown.

Fragments inherit the architecture contract at the top of
[`docs/CLAIM-CONTRACTS.md`](../CLAIM-CONTRACTS.md). In particular, no fragment may
describe uncertainty as being routed to a person, because no example does that
any more.

## Expected files

| File | Owner |
|---|---|
| `01.md` | Example 01 — quickstart |
| `02.md` | Example 02 — judge with rubrics |
| `03.md` | Example 03 — agent harness |
| `04.md` | Example 04 — browser use, simulated |
| `05.md` | Example 05 — browser use, live |
| `06.md` | Example 06 — Jev versus a point-estimate control |
| `07.md` | Example 07 — bounded next-step recommendation |
| `08.md` | Example 08 — residual incident runbook routing |
