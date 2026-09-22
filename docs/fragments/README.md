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
  `README.md`. Use `####` for subsections inside the fragment — a `##` anywhere
  in a fragment would outrank the section it lives in and break the README's
  outline. The assembler refuses a fragment that does not begin at `###`.
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

## How assembly works

`README.md` carries marker lines that reserve the place each fragment is spliced
into:

```
<!-- fragment:04 -->
   ...replaced by docs/fragments/04.md...
<!-- fragment:05 -->
   ...replaced by docs/fragments/05.md...
<!-- fragments:end -->
```

A region runs from its marker to the **next marker of any kind**. Only region
starts are marked, so a fragment can never quietly swallow the section beneath
it, and the sections that are not fragment-owned — the LangChain and eval
sections — sit outside the markers and are never touched.

Run it with:

```bash
npm run readme         # rewrite README.md from the fragments
npm run readme:check   # verify README.md matches, write nothing
```

The script **refuses rather than guessing**. A marker with no fragment file, a
fragment file with no marker, a duplicate marker, or a fragment that does not
begin at `###` all abort with a message naming the problem. Until every example
has landed, `npm run readme` is expected to fail with the list of fragments it
is still waiting on — a README assembled from a partial set would look finished
while describing examples that no longer exist.

`npm run readme:check` is the one to run in CI once assembly has happened, since
it catches a fragment edited without reassembling.

## Expected files

The second column is each fragment's own `###` title, verbatim. `npm run readme`
and `npm run readme:check` verify this table against the files on disk and
refuse if it has drifted, so renaming a fragment's heading without updating this
row fails the build rather than leaving a description that quietly stops being
true.

| File | Title |
|---|---|
| `01.md` | 01 — Quickstart: one request, five questions, and what the answer does next |
| `02.md` | 02 — Model-as-a-judge: when the judge is torn, it decomposes |
| `03.md` | 03 — Agent harness: uncertainty selects the next machine action |
| `04.md` | 04 — Browser use: pick an element, never invent one |
| `05.md` | 05 — The same loop, against a real browser |
| `06.md` | 06 — The same maze, twice |
| `07.md` | 07 — Uncertainty selects the next machine action |
| `08.md` | 08 — Residual incident runbook routing, by expected information gain |
