"""Configuration tests using constructor doubles, not hosted-service calls.

Run: python -B -m unittest discover -s examples/python -p "test_*.py"
These tests do not establish model behavior or replace an installed-SDK smoke.
"""

import os
import sys
import types
import unittest
from unittest.mock import patch

from jev_gateway import (
    GATEWAY_MODEL,
    GATEWAY_URL,
    LOCAL_JEV_URL,
    gateway_classifier,
    gateway_middleware,
    gateway_settings,
)


class ClassifierDouble:
    """The verified 0.0.1a3 fields, with its native environment defaults."""

    def __init__(self, *, api_key=None, base_url=None, model="jev-latest"):
        self.api_key = api_key or os.environ["TYPESAFE_API_KEY"]
        self.base_url = base_url or os.environ.get(
            "TYPESAFE_BASE_URL", "https://api.typesafe.ai"
        )
        self.model = model


class MiddlewareDouble:
    def __init__(self, **kwargs):
        self.classifier = ClassifierDouble()
        self.kwargs = kwargs


class GatewayConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_gateway_key_and_free_catalog_defaults(self):
        os.environ["AI_GATEWAY_API_KEY"] = "  fake-gateway-key  "
        self.assertEqual(
            gateway_settings(),
            {
                "api_key": "fake-gateway-key",
                "base_url": GATEWAY_URL,
                "model": GATEWAY_MODEL,
            },
        )

    def test_oidc_fallback_and_gateway_key_precedence(self):
        os.environ["VERCEL_OIDC_TOKEN"] = "fake-oidc"
        os.environ["AI_GATEWAY_API_KEY"] = " "
        self.assertEqual(gateway_settings()["api_key"], "fake-oidc")
        os.environ["AI_GATEWAY_API_KEY"] = "fake-key"
        self.assertEqual(gateway_settings()["api_key"], "fake-key")

    def test_direct_key_cannot_activate_gateway(self):
        os.environ["TYPESAFE_API_KEY"] = "direct-key-is-not-supported"
        with self.assertRaisesRegex(ValueError, "AI_GATEWAY_API_KEY"):
            gateway_settings()

    def test_explicit_endpoint_and_model_overrides(self):
        os.environ.update(
            AI_GATEWAY_API_KEY="fake",
            AI_GATEWAY_TYPESAFE_BASE_URL="http://127.0.0.1:9000/typesafe",
            TYPESAFE_DEFAULT_MODEL="test-model",
            TYPESAFE_BASE_URL="https://direct-must-not-be-used.invalid",
        )
        settings = gateway_settings()
        self.assertEqual(settings["base_url"], "http://127.0.0.1:9000/typesafe")
        self.assertEqual(settings["model"], "test-model")

    def test_classifier_receives_supported_explicit_fields(self):
        os.environ["AI_GATEWAY_API_KEY"] = "fake"
        module = types.ModuleType("langchain_typesafe")
        module.TypeSafeClassifier = ClassifierDouble
        with patch.dict(sys.modules, {"langchain_typesafe": module}):
            classifier = gateway_classifier()
        self.assertEqual(classifier.api_key, "fake")
        self.assertEqual(classifier.base_url, GATEWAY_URL)
        self.assertEqual(classifier.model, GATEWAY_MODEL)
        self.assertNotIn("TYPESAFE_API_KEY", os.environ)

    def test_middleware_uses_gateway_and_restores_native_environment(self):
        os.environ.update(
            AI_GATEWAY_API_KEY="fake",
            TYPESAFE_API_KEY="old-direct-key",
            TYPESAFE_BASE_URL="https://old-direct.invalid",
        )
        before = dict(os.environ)
        middleware = gateway_middleware(MiddlewareDouble, tools=["delete_file"])
        self.assertEqual(middleware.classifier.api_key, "fake")
        self.assertEqual(middleware.classifier.base_url, GATEWAY_URL)
        self.assertEqual(middleware.classifier.model, GATEWAY_MODEL)
        self.assertEqual(middleware.kwargs, {"tools": ["delete_file"]})
        self.assertEqual(dict(os.environ), before)

    def test_local_backend_targets_the_proxy_and_names_laya(self):
        os.environ.update(JEV_BACKEND="local", TYPESAFE_API_KEY="direct-key")
        self.assertEqual(
            gateway_settings(),
            {"api_key": "local-jev-proxy", "base_url": LOCAL_JEV_URL, "model": "local-laya"},
        )
        os.environ["LOCAL_JEV_URL"] = "http://127.0.0.1:9999/"
        self.assertEqual(gateway_settings()["base_url"], "http://127.0.0.1:9999")
        os.environ["JEV_BACKEND"] = "typesafe-direct"
        with self.assertRaisesRegex(ValueError, "JEV_BACKEND must be"):
            gateway_settings()

    def test_environment_restored_after_constructor_failure(self):
        os.environ["VERCEL_OIDC_TOKEN"] = "fake"
        before = dict(os.environ)

        def fail():
            raise RuntimeError("constructor failed")

        with self.assertRaisesRegex(RuntimeError, "constructor failed"):
            gateway_middleware(fail)
        self.assertEqual(dict(os.environ), before)


if __name__ == "__main__":
    unittest.main()
