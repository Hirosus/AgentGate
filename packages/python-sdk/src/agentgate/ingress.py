"""Shared transport-agnostic HTTP webhook ingress service and environment wiring."""

import importlib
import time
from collections.abc import Callable, Mapping
from typing import Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field

from agentgate.seams import IdempotencyStore, InMemoryIdempotencyStore
from agentgate.stores import (
    DynamoDbIdempotencyStore,
    DynamoDbTableProtocol,
    SqliteIdempotencyStore,
)
from agentgate.types import WebhookEvent
from agentgate.webhook import ingest_webhook


def _default_now() -> int:
    return int(time.time())


@runtime_checkable
class _Closable(Protocol):
    def close(self) -> None: ...


@runtime_checkable
class _DynamoDbResourceProtocol(Protocol):
    def Table(self, name: str) -> object: ...


@runtime_checkable
class _Boto3ModuleProtocol(Protocol):
    def resource(self, service_name: str, region_name: str | None = None) -> object: ...


class IngressConfig(BaseModel):
    """Runtime settings governing webhook authentication and replay window enforcement."""

    model_config = ConfigDict(frozen=True)

    webhook_secret: str = Field(min_length=1)
    max_age_seconds: int = Field(default=300, ge=0)
    idempotency_ttl_seconds: int = Field(default=86400, gt=0)


class HttpResponse(BaseModel):
    """Framework-neutral HTTP response produced by WebhookIngress."""

    model_config = ConfigDict(frozen=True)

    status_code: int
    body: dict[str, str]


class WebhookIngress:
    """Deep ingress module bridging HTTP requests to HMAC verification and idempotency."""

    def __init__(
        self,
        config: IngressConfig,
        store: IdempotencyStore,
        now_fn: Callable[[], int] | None = None,
    ) -> None:
        self._config = config
        self._store = store
        self._now_fn: Callable[[], int] = now_fn if now_fn is not None else _default_now

    @property
    def store(self) -> IdempotencyStore:
        """Return the underlying IdempotencyStore adapter."""
        return self._store

    def close(self) -> None:
        """Close the underlying store if it owns releasable resources (e.g. SQLite)."""
        if isinstance(self._store, _Closable):
            self._store.close()

    def handle_health(self) -> HttpResponse:
        """Return service health probe payload."""
        return HttpResponse(status_code=200, body={"status": "ok"})

    def handle_triage_webhook(
        self,
        headers: Mapping[str, str],
        raw_body: bytes,
    ) -> HttpResponse:
        """Validate headers, verify raw-body HMAC signature, and claim idempotency key."""
        lowered = {k.lower(): v for k, v in headers.items()}

        idempotency_key = lowered.get("x-agentgate-idempotency-key", "").strip()
        if not idempotency_key:
            return HttpResponse(
                status_code=400,
                body={"detail": "Missing required X-AgentGate-Idempotency-Key header."},
            )

        signature = lowered.get("x-agentgate-signature", "").strip()
        if not signature:
            return HttpResponse(
                status_code=400,
                body={"detail": "Missing required X-AgentGate-Signature header."},
            )

        raw_timestamp = lowered.get("x-agentgate-timestamp", "").strip()
        if not raw_timestamp or not raw_timestamp.isascii() or not raw_timestamp.isdigit():
            return HttpResponse(
                status_code=400,
                body={"detail": "X-AgentGate-Timestamp must be a non-negative integer."},
            )
        timestamp = int(raw_timestamp)

        source = lowered.get("x-agentgate-source", "").strip() or "webhook"
        event = WebhookEvent(
            idempotency_key=idempotency_key,
            timestamp=timestamp,
            raw_body=raw_body,
            source=source,
        )
        decision = ingest_webhook(
            event=event,
            signature_header=signature,
            secret=self._config.webhook_secret,
            store=self._store,
            now_timestamp=self._now_fn(),
            max_age_seconds=self._config.max_age_seconds,
            idempotency_ttl_seconds=self._config.idempotency_ttl_seconds,
        )
        status_code = 200 if decision.status in ("accepted", "duplicate") else 401
        return HttpResponse(
            status_code=status_code,
            body={
                "status": decision.status,
                "idempotency_key": decision.idempotency_key,
                "reason": decision.reason,
            },
        )


def _load_dynamodb_table(table_name: str, region_name: str | None) -> DynamoDbTableProtocol:
    boto3_module: object = importlib.import_module("boto3")
    if not isinstance(boto3_module, _Boto3ModuleProtocol):
        raise RuntimeError("Loaded boto3 module does not expose resource().")
    resource: object = boto3_module.resource("dynamodb", region_name=region_name)
    if not isinstance(resource, _DynamoDbResourceProtocol):
        raise RuntimeError("DynamoDB resource does not expose Table().")
    table: object = resource.Table(table_name)
    if not isinstance(table, DynamoDbTableProtocol):
        raise RuntimeError("DynamoDB Table resource does not expose put_item().")
    return table


def _parse_int_env(env: Mapping[str, str], key: str, default: int) -> int:
    raw = env.get(key, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"{key} must be an integer, got {raw!r}.") from exc


def create_ingress_from_env(
    env: Mapping[str, str],
    *,
    now_fn: Callable[[], int] | None = None,
    dynamodb_table: DynamoDbTableProtocol | None = None,
) -> WebhookIngress:
    """Build a configured WebhookIngress and IdempotencyStore from environment variables."""
    secret = env.get("AGENTGATE_WEBHOOK_SECRET", "").strip()
    if not secret:
        raise ValueError("AGENTGATE_WEBHOOK_SECRET must be set.")

    config = IngressConfig(
        webhook_secret=secret,
        max_age_seconds=_parse_int_env(env, "AGENTGATE_WEBHOOK_MAX_AGE_SECONDS", 300),
        idempotency_ttl_seconds=_parse_int_env(env, "AGENTGATE_IDEMPOTENCY_TTL_SECONDS", 86400),
    )

    backend = env.get("AGENTGATE_STORE_BACKEND", "sqlite").strip().lower() or "sqlite"
    store: IdempotencyStore
    if backend == "sqlite":
        db_path = env.get("AGENTGATE_SQLITE_PATH", "").strip() or "./data/agentgate.db"
        store = SqliteIdempotencyStore(db_path=db_path, now_fn=now_fn)
    elif backend == "memory":
        initial_time = now_fn() if now_fn is not None else _default_now()
        store = InMemoryIdempotencyStore(current_time=initial_time)
    elif backend == "dynamodb":
        table = dynamodb_table
        if table is None:
            table_name = env.get("IDEMPOTENCY_TABLE", "").strip()
            if not table_name:
                raise ValueError("IDEMPOTENCY_TABLE must be set when backend is 'dynamodb'.")
            region = env.get("AWS_REGION", "").strip() or None
            table = _load_dynamodb_table(table_name=table_name, region_name=region)
        store = DynamoDbIdempotencyStore(table=table, now_fn=now_fn)
    else:
        raise ValueError(f"Unsupported AGENTGATE_STORE_BACKEND: {backend!r}.")

    return WebhookIngress(config=config, store=store, now_fn=now_fn)
