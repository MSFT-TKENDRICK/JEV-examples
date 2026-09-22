"""
LangChain + Jev: agent harness middleware.

LangChain's TypeSafe integration ships two middlewares that are exactly the
harness decisions the TypeScript example in this repo implements by hand:

    ModelRouterMiddleware  -> which model handles this run
    AutoModeMiddleware     -> whether a proposed tool call is too risky to run

LangChain's own framing is that `AutoModeMiddleware` open-sources the
dangerous-action classifier that harnesses like Claude Code and Cursor keep
closed. That is the clearest statement of what Jev is for in an agent: the
cheap, fast, structured judgment that gates an expensive, irreversible action.

    pip install -r requirements.txt
    export TYPESAFE_API_KEY=...
    export OPENAI_API_KEY=...

Caveats worth respecting:
  - The package is alpha (0.0.1a3) and the middleware is explicitly
    experimental. Pin the version.
  - `AutoModeMiddleware` REFUSES risky calls; it returns an error ToolMessage.
    It does not prompt. Pair it with human-in-the-loop middleware if you want a
    person to approve rather than simply be denied.
  - Confidence summarizes how concentrated a distribution is. It is not a
    measure of whether the overall workflow is correct, nor permission to act.

Run:  python examples/python/langchain_harness.py
"""

from __future__ import annotations

import os

from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware, AgentState, Runtime
from langchain_typesafe import Choice, ChoiceAnswer, NoulCriteria, TypeSafeClassifier
from langchain_typesafe.experimental.middleware import (
    AutoModeMiddleware,
    ModelChoice,
    ModelRouterMiddleware,
)
from typing_extensions import NotRequired


# ---------------------------------------------------------------------------
# 1. Model routing — spend the big model only where it earns its cost.
# ---------------------------------------------------------------------------
router = ModelRouterMiddleware(
    choices={
        "fast": ModelChoice(
            model="openai:gpt-4o-mini",
            criteria=(
                "Direct lookups, extraction, and localized changes with "
                "explicit targets."
            ),
        ),
        "powerful": ModelChoice(
            model="openai:gpt-4o",
            criteria=(
                "Architecture, novel root-cause reasoning, and high-stakes "
                "decisions."
            ),
        ),
    },
    instructions="Choose the least costly model that can complete the task safely.",
)


# ---------------------------------------------------------------------------
# 2. Tool-risk gating — one Noul, applied to every proposed tool call.
# ---------------------------------------------------------------------------
def read_file(path: str) -> str:
    """Read a file from the workspace."""
    return f"<contents of {path}>"


def delete_file(path: str) -> str:
    """Permanently delete a file from the workspace."""
    return f"deleted {path}"


auto_mode = AutoModeMiddleware(
    tools=[delete_file],
    criteria=NoulCriteria(
        true="The call writes, deletes, publishes, or changes access.",
        false="The call only reads public or user-provided data.",
    ),
)


# ---------------------------------------------------------------------------
# 3. Custom middleware — the reusable shape for any harness decision.
#
# Note what gets passed as `state`: the message list itself. Jev accepts
# structured state, so a transcript needs no serialization ceremony.
# ---------------------------------------------------------------------------
class TriageState(AgentState):
    triage: NotRequired[ChoiceAnswer]


class TriageMiddleware(AgentMiddleware[TriageState]):
    """Classifies the conversation once, before the agent starts work."""

    state_schema = TriageState

    def __init__(self) -> None:
        self.classifier = TypeSafeClassifier()

    def before_agent(
        self, state: TriageState, runtime: Runtime
    ) -> dict[str, ChoiceAnswer]:
        response = self.classifier.invoke(
            {
                "state": state["messages"],
                "questions": {
                    "triage": Choice(
                        instructions="Which team should handle this conversation?",
                        criteria={
                            "billing": "Charges, invoices, refunds, subscriptions.",
                            "infra": "Deploys, availability, on-call incidents.",
                            "other": "Anything else.",
                        },
                    )
                },
            }
        )
        return {"triage": response.choices["triage"]}


# Use `before_model` instead of `before_agent` to reclassify after every tool
# result, or `wrap_tool_call` to classify a specific proposed action.


def main() -> None:
    missing = [
        name
        for name in ("TYPESAFE_API_KEY", "OPENAI_API_KEY")
        if not os.environ.get(name)
    ]
    if missing:
        raise SystemExit(f"Set {' and '.join(missing)} before running this example.")

    agent = create_agent(
        "openai:gpt-4o-mini",
        tools=[read_file, delete_file],
        middleware=[router, auto_mode, TriageMiddleware()],
    )

    result = agent.invoke(
        {
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "The checkout service is 500ing after the 14:02 deploy. "
                        "Find out why."
                    ),
                }
            ]
        }
    )

    # ModelRouterMiddleware writes its decision to the `model_route` state key.
    route = result["model_route"]
    triage = result["triage"]

    print(f"model route : {route.choice} ({route.confidence:.0%} confidence)")
    print(f"triage      : {triage.choice} ({triage.confidence:.0%} confidence)")
    print(f"final       : {result['messages'][-1].content}")


if __name__ == "__main__":
    main()
