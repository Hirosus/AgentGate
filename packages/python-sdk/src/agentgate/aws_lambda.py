"""AWS Lambda API Gateway HTTP API v2 handler backed by WebhookIngress."""

import base64
import binascii
import json
import os
import threading
from collections.abc import Callable, Mapping

from agentgate.ingress import WebhookIngress, create_ingress_from_env

LambdaResponse = dict[str, int | str | dict[str, str]]

_handler_lock = threading.Lock()
_default_ingress: WebhookIngress | None = None
_default_handler: Callable[[Mapping[str, object], object], LambdaResponse] | None = None


def _json_response(status_code: int, body: dict[str, str]) -> LambdaResponse:
    return {
        "statusCode": status_code,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body),
    }


def _extract_method_and_path(event: Mapping[str, object]) -> tuple[str, str]:
    method = ""
    stage = ""

    request_context = event.get("requestContext")
    if isinstance(request_context, Mapping):
        raw_stage = request_context.get("stage")
        if isinstance(raw_stage, str):
            stage = raw_stage
        http_ctx = request_context.get("http")
        if isinstance(http_ctx, Mapping):
            raw_method = http_ctx.get("method")
            if isinstance(raw_method, str):
                method = raw_method

    if not method:
        fallback_method = event.get("httpMethod")
        if isinstance(fallback_method, str):
            method = fallback_method

    raw_path = event.get("rawPath")
    if not isinstance(raw_path, str):
        fallback_path = event.get("path")
        path = fallback_path if isinstance(fallback_path, str) else ""
    else:
        path = raw_path

    if stage and stage != "$default":
        prefix = f"/{stage}"
        if path == prefix:
            path = "/"
        elif path.startswith(f"{prefix}/"):
            path = path[len(prefix) :]

    return method.upper(), path


def _extract_headers(event: Mapping[str, object]) -> dict[str, str]:
    raw_headers = event.get("headers")
    if not isinstance(raw_headers, Mapping):
        return {}
    return {
        key: value
        for key, value in raw_headers.items()
        if isinstance(key, str) and isinstance(value, str)
    }


def _extract_body_bytes(event: Mapping[str, object]) -> bytes:
    raw_body = event.get("body")
    if raw_body is None:
        return b""
    if isinstance(raw_body, bytes):
        return raw_body
    if not isinstance(raw_body, str):
        raise ValueError("Unsupported request body type.")

    if event.get("isBase64Encoded") is True:
        try:
            return base64.b64decode(raw_body.encode("ascii"), validate=True)
        except (binascii.Error, UnicodeEncodeError, ValueError) as exc:
            raise ValueError("Invalid base64-encoded request body.") from exc

    return raw_body.encode("utf-8")


def build_lambda_handler(
    ingress: WebhookIngress,
) -> Callable[[Mapping[str, object], object], LambdaResponse]:
    """Wrap a configured WebhookIngress into an AWS Lambda API Gateway v2 handler."""

    def lambda_handler(event: Mapping[str, object], context: object) -> LambdaResponse:
        del context
        method, path = _extract_method_and_path(event)

        if method == "GET" and path == "/health":
            res = ingress.handle_health()
            return _json_response(res.status_code, res.body)

        if method == "POST" and path == "/webhooks/triage":
            try:
                body_bytes = _extract_body_bytes(event)
            except ValueError as exc:
                return _json_response(400, {"detail": str(exc)})
            headers = _extract_headers(event)
            res = ingress.handle_triage_webhook(headers, body_bytes)
            return _json_response(res.status_code, res.body)

        return _json_response(
            404,
            {"detail": f"Route not found: {method or 'UNKNOWN'} {path or '/'}"},
        )

    return lambda_handler


def reset_default_handler() -> None:
    """Clear the cached module-level Lambda handler and release any open store."""
    global _default_handler, _default_ingress
    with _handler_lock:
        if _default_ingress is not None:
            _default_ingress.close()
        _default_ingress = None
        _default_handler = None


def handler(event: Mapping[str, object], context: object) -> LambdaResponse:
    """Default AWS Lambda entrypoint lazily configured from environment variables."""
    global _default_handler, _default_ingress
    with _handler_lock:
        if _default_handler is None:
            _default_ingress = create_ingress_from_env(os.environ)
            _default_handler = build_lambda_handler(_default_ingress)
        active_handler = _default_handler
    return active_handler(event, context)
