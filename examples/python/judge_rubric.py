"""
LangChain + Jev: a rubric judge.

The official LangChain integration for TypeSafe is Python-only. There is no
`@langchain/typesafe` on npm, so if you want Jev inside LangChain today, this is
the language.

    pip install "langchain-typesafe==0.0.1a3"
    export TYPESAFE_API_KEY=...

Two naming differences from the Vercel AI SDK, which trip people up when they
port code between the two:

    concept          AI SDK            native / LangChain
    ---------------  ----------------  ------------------
    yes/no question  type "boolean"    Noul
    its answer       .probability      .noul
    confidence       providerMetadata  .confidence on the answer itself
    score legend     (not returned)    .legend on the answer

`TypeSafeClassifier` is a plain Runnable, so it composes with LCEL like anything
else. LangChain does not ship a rubric-judge helper — you build it from Score,
which is the same thing this repo's TypeScript example does.

Run:  python examples/python/judge_rubric.py
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from langchain_typesafe import Choice, Noul, Score, TypeSafeClassifier

REFERENCE = (
    "The standard refund window is 30 days. After 30 days refunds are not "
    "automatic, but a support agent can grant an exception for billing errors "
    "or unused annual plans. Direct the customer to open a support ticket."
)

CANDIDATES = {
    "model-a": (
        "Our refund window is 30 days, so a 40-day-old purchase is outside the "
        "automatic window. Exceptions exist for billing errors and unused annual "
        "plans. Open a support ticket and an agent will review your case."
    ),
    "model-b": "No. Refunds are 30 days only.",
    "model-c": (
        "Absolutely, we offer a full no-questions-asked refund for 90 days on "
        "every plan. I've gone ahead and processed it for you now."
    ),
}

# Each dimension is atomic. Levels describe concrete situations and stand on
# their own, because the model sees the level descriptions and nothing else.
RUBRIC = {
    "factual": Score(
        instructions="How well does `response` match the policy stated in `reference`?",
        criteria=[
            "Contradicts the reference policy",
            "Partly correct but omits or distorts a material condition",
            "Consistent with the reference, with minor gaps",
            "Fully consistent with the reference, including its conditions",
        ],
    ),
    "completeness": Score(
        instructions="Does `response` give the customer everything they need to act?",
        criteria=[
            "States a conclusion with no actionable next step",
            "Mentions a next step but leaves it vague",
            "Gives a clear, specific next step",
        ],
    ),
    "tone": Score(
        instructions="How appropriate is the tone for a customer support reply?",
        criteria=["Curt or dismissive", "Neutral and businesslike", "Warm and helpful"],
    ),
    # Safety checks are separate conditions, never weights in the average.
    "invents_policy": Noul(
        instructions="Does `response` state a policy detail absent from `reference`?",
    ),
    "promises_action": Noul(
        instructions="Does `response` claim an irreversible action has already happened?",
    ),
    # A Choice makes the overall shape of the answer explicit and checkable.
    "outcome": Choice(
        instructions="Classify what `response` does.",
        criteria={
            "answered": "Answers the question and points to a next step",
            "declined": "Refuses without offering a path forward",
            "overpromised": "Grants something the policy does not support",
        },
    ),
}

# Weights are ordinary numbers you own. Changing what you value is a
# coefficient change, not a prompt rewrite.
WEIGHTS = {"factual": 0.5, "completeness": 0.3, "tone": 0.2}

# Calibrate these against labeled examples. Do not assume 0.5 is meaningful.
SAFETY_THRESHOLD = 0.7
PASS_THRESHOLD = 0.75
FAIL_THRESHOLD = 0.45


@dataclass
class Judgment:
    candidate: str
    composite: float
    verdict: str
    outcome: str
    violations: list[str]


def normalize(score: float, level_count: int) -> float:
    """A Score lands in [0, levels - 1], so divide by levels - 1."""
    if level_count < 2:
        raise ValueError("A Score question needs at least two levels")
    return score / (level_count - 1)


def judge(classifier: TypeSafeClassifier, candidate: str, response: str) -> Judgment:
    # One request. Every question sees the same state and runs in parallel.
    result = classifier.invoke(
        {
            "state": {
                "prompt": "Can I get a refund 40 days after purchase?",
                "reference": REFERENCE,
                "response": response,
            },
            "questions": RUBRIC,
        }
    )

    # Answers come back grouped by type: .scores, .nouls, .choices.
    dimensions = {
        name: normalize(result.scores[name].score, len(RUBRIC[name].criteria))
        for name in WEIGHTS
    }
    composite = sum(WEIGHTS[name] * value for name, value in dimensions.items())

    violations: list[str] = []
    if result.nouls["invents_policy"].noul >= SAFETY_THRESHOLD:
        violations.append("invents policy")
    if result.nouls["promises_action"].noul >= SAFETY_THRESHOLD:
        violations.append("claims an irreversible action")

    if violations:
        verdict = "fail"
    elif composite >= PASS_THRESHOLD:
        verdict = "pass"
    elif composite < FAIL_THRESHOLD:
        verdict = "fail"
    else:
        verdict = "review"

    outcome = result.choices["outcome"]
    # Unlike the AI SDK, confidence is on the answer itself here.
    label = f"{outcome.choice} ({outcome.confidence:.0%} confidence)"

    return Judgment(candidate, composite, verdict, label, violations)


def main() -> None:
    if not os.environ.get("TYPESAFE_API_KEY"):
        raise SystemExit("Set TYPESAFE_API_KEY before running this example.")

    classifier = TypeSafeClassifier()

    print(f"{'candidate':<10} {'score':>6}  {'verdict':<8} outcome")
    print("-" * 64)
    for candidate, response in CANDIDATES.items():
        judgment = judge(classifier, candidate, response)
        print(
            f"{judgment.candidate:<10} {judgment.composite:>6.3f}  "
            f"{judgment.verdict:<8} {judgment.outcome}"
        )
        for violation in judgment.violations:
            print(f"{'':<10} {'':>6}  {'':<8} ! {violation}")


if __name__ == "__main__":
    main()
