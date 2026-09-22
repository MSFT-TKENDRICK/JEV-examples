# README fragments

Each FSI example writes its README section here instead of editing `README.md`.

## Why

The two FSI examples are built in parallel, in separate git worktrees, by separate
sessions. If both edited `README.md` the merge conflict would be guaranteed — same
file, adjacent sections, no shared history between the branches until they land.

So the rule is: **a child session never edits `README.md` or `package.json`.** It
writes `docs/fragments/<nn>.md`, and the integration phase assembles the fragments
into `README.md` once both examples have merged.

## Contract for a fragment

- Start at heading level `###`, matching the existing per-example sections in
  `README.md`.
- Open with a link to the example file and a one-line statement of what it shows.
- Include the example's allowed-claims / must-not-claim summary, or link to
  [`docs/CLAIM-CONTRACTS.md`](../CLAIM-CONTRACTS.md).
- State the scripted-fixture constraint explicitly. Do not rely on the reader
  having seen it elsewhere in the README.
- Show real output from a real run, not illustrative output.

## Expected files

| File | Owner |
|---|---|
| `07.md` | Example 07 — bounded next-step recommendation |
| `08.md` | Example 08 — residual incident runbook routing |
