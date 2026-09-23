"""Jev through Vercel AI Gateway, with no direct TypeSafe fallback.

Constructor fields and middleware behavior verified against the pinned source:
https://github.com/langchain-ai/langchain/tree/langchain-typesafe%3D%3D0.0.1a3/libs/partners/typesafe
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from langchain_typesafe import TypeSafeClassifier

GATEWAY_URL = "https://ai-gateway.vercel.sh/typesafe"
GATEWAY_MODEL = "typesafe-ai/jev"
LOCAL_JEV_URL = "http://127.0.0.1:8765"


def gateway_settings() -> dict[str, str]:
    """Pass supported classifier fields explicitly; never consume a direct key.

    JEV_BACKEND=local points the classifier at the local Laya proxy
    (`npm run local-jev`): same wire format, a different model, not Jev.
    """
    backend = os.environ.get("JEV_BACKEND", "").strip() or "gateway"
    if backend == "local":
        return {
            "api_key": "local-jev-proxy",
            "base_url": os.environ.get("LOCAL_JEV_URL", "").strip().rstrip("/")
            or LOCAL_JEV_URL,
            "model": "local-laya",
        }
    if backend != "gateway":
        raise ValueError(
            "JEV_BACKEND must be gateway (default, Jev via Vercel AI Gateway) "
            "or local (Laya proxy, not Jev)."
        )
    credential = (
        os.environ.get("AI_GATEWAY_API_KEY", "").strip()
        or os.environ.get("VERCEL_OIDC_TOKEN", "").strip()
    )
    if not credential:
        raise ValueError(
            "Set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN for free Jev through "
            "Vercel AI Gateway. No TYPESAFE_API_KEY is needed. Without Gateway "
            "access, JEV_BACKEND=local uses the local Laya proxy (not Jev)."
        )
    return {
        "api_key": credential,
        "base_url": os.environ.get("AI_GATEWAY_TYPESAFE_BASE_URL", "").strip()
        or GATEWAY_URL,
        "model": os.environ.get("TYPESAFE_DEFAULT_MODEL", "").strip()
        or GATEWAY_MODEL,
    }


def gateway_classifier() -> TypeSafeClassifier:
    from langchain_typesafe import TypeSafeClassifier

    return TypeSafeClassifier(**gateway_settings())


def gateway_middleware(factory: Callable[..., Any], **kwargs: Any) -> Any:
    """Construct the pinned middleware with Gateway-only classifier settings.

    Version 0.0.1a3 has no classifier constructor argument: both middlewares
    internally create TypeSafeClassifier(). During this single-threaded CLI's
    construction, scope its native credential/URL variables to Gateway values.
    No requests occur in the constructor. Restore the environment immediately
    and set the supported classifier model field before any invocation.
    """
    settings = gateway_settings()
    native = {
        "TYPESAFE_API_KEY": settings["api_key"],
        "TYPESAFE_BASE_URL": settings["base_url"],
    }
    saved = {name: os.environ.get(name) for name in native}
    try:
        os.environ.update(native)
        middleware = factory(**kwargs)
    finally:
        for name, value in saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
    middleware.classifier.model = settings["model"]
    return middleware
