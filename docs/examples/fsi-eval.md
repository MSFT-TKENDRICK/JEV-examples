# FSI evaluation: what the thresholds are worth

[`examples/fsi/eval/`](../../examples/fsi/eval) — run with `npm run fsi:eval`.

Examples 07 and 08 both gate on the same three distribution statistics, with
numbers chosen by their authors. `npm run fsi:eval` runs both examples as
subprocesses, reads their ledgers back, and re-scores every recorded decision
against a sweep of thresholds. Nothing in either pipeline is reimplemented to do it.

**The sweep always runs on scripted fixtures** (`JEV_MOCK=1`), regardless of
your credentials or mode. It does not measure live Jev.

## What the table shows

The table trades acting against investigating, which is the ordinary reason to
sweep a threshold. The column that matters is the last one: decisions that
**passed every distribution test and were then vetoed by deterministic code**.
That column is computed, not labelled. It falls out of comparing each recorded
decision's metrics against its own recorded thresholds, and then reading whether
the executed action diverged from the recommendation.

The fixture run recorded three such decisions: two in example 07 and one in
example 08. The tables below are the output of that run, with intermediate
lines elided where marked.

```
07 — Card servicing: bounded next-step selection
  12 decision(s), 10 with a usable distribution to threshold on

  min mass  scored    acts  investigates  contradicted
      0.50      10       9             1             2
      ...
      0.85      10       5             5             2
      0.90      10       0            10             0
      0.95      10       0            10             0
```

```
08 — Residual incident runbook routing
  16 decision(s), 7 with a usable distribution to threshold on

  min mass  scored    acts  investigates  contradicted
      0.50       7       5             2             1
      ...
      0.90       7       4             3             1
      0.95       7       0             7             0
```

Example 08's contradicted decision is incident `INC-4480`: the 91% recommendation
of `RM-HSM-KEYSYNC`, whose precondition, that `HSM-01` is in the incident's affected
CI set, does not hold. Revalidation against authoritative state refused it. The
decision clears every threshold up to `0.90`. Only `0.95` excludes it, and `0.95`
also shuts the automation off entirely, so nothing is acted on at all. It survives
the tightening because it was never an uncertain answer: it was a confident answer
to a question asked against stale state.

Example 07's two contradicted decisions behave the same way up to `0.85`. They
are excluded only at `0.90`, where the policy also stops acting on everything. So
in neither example does a threshold remove the contradiction while the automation
stays on.

That is the argument for keeping the deterministic preconditions, not for picking
a better number. A threshold sweep can buy you coverage or caution. It cannot buy
you the check that reads authoritative state.

## Why there is no accuracy column

**There is no accuracy column, deliberately.** The distributions come from
[`src/mock-fetch.ts`](../../src/mock-fetch.ts), which scripts both the answer and the
shape of the distribution around it. Scoring accuracy over manufactured
distributions would measure the fixture author, not the model. The fixture labels
in both examples are recorded as priors committed before the run, and they are
explicitly not treated as ground truth.

## Live perturbation (not run here)

[`perturb.ts`](../../examples/fsi/eval/perturb.ts) is the live counterpart. It holds
a synthetic scenario's state and questions fixed while measuring a baseline, adding
a spurious option, removing an unselected option, and reordering the options. It
emits the returned distributions and raw shared-option mass deltas, and does not
execute the recommended actions. Removal changes normalization, and one sample per
variant cannot separate sampling variation from option-set effects. This is not an
accuracy score or a pass/fail stability test. **No live perturbation results are
published here.**

It requires `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` and rejects `JEV_MOCK=1`.
After configuring `.env` for live use, run:

```bash
node --env-file-if-exists=.env examples/fsi/eval/perturb.ts
```
