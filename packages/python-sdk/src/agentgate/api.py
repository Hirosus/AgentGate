"""FastAPI ASGI adapter exposing AgentGate health and webhook triage endpoints."""

import os
from collections.abc import Callable, Mapping

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from agentgate.ingress import IngressConfig, WebhookIngress, create_ingress_from_env
from agentgate.seams import IdempotencyStore


def create_app_from_ingress(ingress: WebhookIngress) -> FastAPI:
    """Create a FastAPI application backed by an existing WebhookIngress instance."""
    app = FastAPI(title="AgentGate Webhook Ingress", version="0.1.0")

    @app.get("/health")
    async def health() -> JSONResponse:
        res = ingress.handle_health()
        return JSONResponse(status_code=res.status_code, content=res.body)

    @app.post("/webhooks/triage")
    async def triage_webhook(request: Request) -> JSONResponse:
        raw_body = await request.body()
        res = ingress.handle_triage_webhook(request.headers, raw_body)
        return JSONResponse(status_code=res.status_code, content=res.body)

    return app


def create_app(
    config: IngressConfig,
    store: IdempotencyStore,
    now_fn: Callable[[], int] | None = None,
) -> FastAPI:
    """Create a FastAPI application from explicit config and IdempotencyStore."""
    ingress = WebhookIngress(config=config, store=store, now_fn=now_fn)
    return create_app_from_ingress(ingress)


def create_app_from_env(env: Mapping[str, str] | None = None) -> FastAPI:
    """Create a FastAPI application configured from environment variables."""
    resolved_env: Mapping[str, str] = os.environ if env is None else env
    ingress = create_ingress_from_env(resolved_env)
    return create_app_from_ingress(ingress)
