"""FastAPI ASGI adapter exposing AgentGate health and webhook triage endpoints."""

import asyncio
import os
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from agentgate.ingress import IngressConfig, WebhookIngress, create_ingress_from_env
from agentgate.seams import IdempotencyStore
from agentgate.types import AgentOutput, WebhookEvent


def create_app_from_ingress(ingress: WebhookIngress) -> FastAPI:
    """Create a FastAPI application backed by an existing WebhookIngress instance."""

    @asynccontextmanager
    async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            await asyncio.to_thread(ingress.close)

    app = FastAPI(
        title="AgentGate Webhook Ingress",
        version="0.1.0",
        lifespan=_lifespan,
    )

    @app.get("/health")
    async def health() -> JSONResponse:
        res = ingress.handle_health()
        return JSONResponse(status_code=res.status_code, content=res.body)

    @app.post("/webhooks/triage")
    async def triage_webhook(request: Request) -> JSONResponse:
        max_bytes = ingress.config.max_body_bytes
        content_length = request.headers.get("content-length")
        if content_length is not None:
            stripped_cl = content_length.strip()
            if stripped_cl.isascii() and stripped_cl.isdigit() and int(stripped_cl) > max_bytes:
                return JSONResponse(
                    status_code=413,
                    content={"detail": "Request payload exceeds maximum allowed size."},
                )

        chunks: list[bytes] = []
        total_bytes = 0
        async for chunk in request.stream():
            total_bytes += len(chunk)
            if total_bytes > max_bytes:
                return JSONResponse(
                    status_code=413,
                    content={"detail": "Request payload exceeds maximum allowed size."},
                )
            chunks.append(chunk)
        raw_body = b"".join(chunks)

        header_pairs = [
            (key.decode("latin-1"), value.decode("latin-1"))
            for key, value in request.headers.raw
        ]
        res = await asyncio.to_thread(ingress.handle_triage_webhook, header_pairs, raw_body)
        return JSONResponse(status_code=res.status_code, content=res.body)

    return app


def create_app(
    config: IngressConfig,
    store: IdempotencyStore,
    now_fn: Callable[[], int] | None = None,
    triage_runner: Callable[[WebhookEvent], AgentOutput] | None = None,
) -> FastAPI:
    """Create a FastAPI application from explicit config and IdempotencyStore."""
    ingress = WebhookIngress(
        config=config,
        store=store,
        now_fn=now_fn,
        triage_runner=triage_runner,
    )
    return create_app_from_ingress(ingress)


def create_app_from_env(
    env: Mapping[str, str] | None = None,
    *,
    triage_runner: Callable[[WebhookEvent], AgentOutput] | None = None,
) -> FastAPI:
    """Create a FastAPI application configured from environment variables."""
    resolved_env: Mapping[str, str] = os.environ if env is None else env
    ingress = create_ingress_from_env(resolved_env, triage_runner=triage_runner)
    return create_app_from_ingress(ingress)
