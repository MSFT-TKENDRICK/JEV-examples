# LangChain (Python)

LangChain's TypeSafe integration is available for Python as `langchain-typesafe`,
and for JavaScript as `@langchain/typesafe` (npm, MIT, published from
`langchain-ai/langchainjs`). This repository's LangChain examples are Python only.

> **No live Python results are published here.** These examples use the published
> `langchain-typesafe` API. They are not fixture-backed alternatives to the
> TypeScript examples, and live behaviour still needs validation.

## Credentials and routes

The examples send Jev requests through Vercel AI Gateway, not the direct TypeSafe
service:

- `examples/python/jev_gateway.py` configures the classifier with
  `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`, the Gateway base URL and
  `typesafe-ai/jev`. It refuses to run without a Gateway credential.
- Both the PyPI page for `langchain-typesafe` and the `@langchain/typesafe` package
  read a direct `TYPESAFE_API_KEY`. This repository does not use that route, so
  those packages' defaults are not what the examples run. Evaluate them against the
  Gateway route before using them here.
- `judge_rubric.py` needs only the Gateway credential.
- `langchain_harness.py` additionally needs `OPENAI_API_KEY` and makes paid OpenAI
  generation when run. A Gateway credential does not enable those calls, and the
  TypeScript `AI_GATEWAY_GENERATIVE=1` switch does not control this Python provider.

## Files

- [`judge_rubric.py`](../../examples/python/judge_rubric.py): the rubric judge from
  example 02, using `TypeSafeClassifier` with `Score`, `Noul` and `Choice`.
- [`langchain_harness.py`](../../examples/python/langchain_harness.py):
  `ModelRouterMiddleware` and `AutoModeMiddleware`, the routing and permission gates
  from example 03 as drop-in middleware, plus a custom `before_agent` middleware
  showing the general shape.
- [`jev_gateway.py`](../../examples/python/jev_gateway.py): the shared Gateway
  configuration. Honours `JEV_BACKEND=local` and `LOCAL_JEV_URL` (see
  [`local-jev/README.md`](../../local-jev/README.md)).
- [`test_jev_gateway.py`](../../examples/python/test_jev_gateway.py): configuration
  tests that use constructor doubles, not hosted-service calls.

## Install and test

```bash
pip install -r examples/python/requirements.txt
python -B -m unittest discover -s examples/python -p "test_*.py"
```

The requirements pin `langchain-typesafe[experimental]==0.0.1a3`. That is the
latest release on PyPI as of 2026-10-08 (earlier releases: `0.0.1a1`, `0.0.1a2`).
It is alpha, the middleware module is explicitly experimental, and the package has
had one breaking change already, so keep the pin.

`AutoModeMiddleware` **refuses** a risky call with an error `ToolMessage`; it does
not prompt. Pair it with human-in-the-loop middleware if you want a person in the
path. The unit tests check configuration only and do not run a model.
