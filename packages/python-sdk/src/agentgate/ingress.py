"""Shared transport-agnostic HTTP webhook ingress service and environment wiring."""

import importlib
import logging
import time
from collections.abc import Callable, Mapping, Sequence
from typing import Literal, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from agentgate.mcp_client import run_deterministic_triage
from agentgate.seams import IdempotencyStore, InMemoryIdempotencyStore
from agentgate.stores import (
    DynamoDbIdempotencyStore,
    DynamoDbTableProtocol,
    SqliteIdempotencyStore,
)
from agentgate.types import AgentOutput, WebhookEvent
from agentgate.webhook import ingest_webhook

_LOGGER = logging.getLogger(__name__)
_SECURITY_HEADERS = frozenset(
    {
        "x-agentgate-idempotency-key",
        "x-agentgate-signature",
        "x-agentgate-timestamp",
        "x-agentgate-source",
    }
)


def _default_now() -> int:
    return int(time.time())


def _default_deterministic_triage(event: WebhookEvent) -> AgentOutput:
    return run_deterministic_triage(event.raw_body.decode("utf-8", errors="replace"))


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
    allow_legacy_v1: bool = False
    max_body_bytes: int = Field(default=1_048_576, gt=0)
    triage_mode: Literal["none", "deterministic"] = "none"

    @model_validator(mode="after")
    def _validate_ttl_covers_replay_window(self) -> "IngressConfig":
        if self.idempotency_ttl_seconds < self.max_age_seconds:
            raise ValueError(
                "idempotency_ttl_seconds must be greater than or equal to max_age_seconds."
            )
        return self


class HttpResponse(BaseModel):
    """Framework-neutral HTTP response produced by WebhookIngress."""

    model_config = ConfigDict(frozen=True)

    status_code: int
    body: dict[str, JsonValue]


class WebhookIngress:
    """Deep ingress module bridging HTTP requests to HMAC verification and idempotency."""

    def __init__(
        self,
        config: IngressConfig,
        store: IdempotencyStore,
        now_fn: Callable[[], int] | None = None,
        triage_runner: Callable[[WebhookEvent], AgentOutput] | None = None,
    ) -> None:
        self._config = config
        self._store = store
        self._now_fn: Callable[[], int] = now_fn if now_fn is not None else _default_now
        if triage_runner is not None:
            self._triage_runner: Callable[[WebhookEvent], AgentOutput] | None = triage_runner
        elif config.triage_mode == "deterministic":
            self._triage_runner = _default_deterministic_triage
        else:
            self._triage_runner = None

    @property
    def config(self) -> IngressConfig:
        """Return the immutable IngressConfig settings."""
        return self._config

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
        headers: Sequence[tuple[str, str]] | Mapping[str, str],
        raw_body: bytes,
    ) -> HttpResponse:
        """Validate headers, verify raw-body HMAC signature, claim key, and optionally triage."""
        if len(raw_body) > self._config.max_body_bytes:
            return HttpResponse(
                status_code=413,
                body={"detail": "Request payload exceeds maximum allowed size."},
            )

        pairs: Sequence[tuple[str, str]] = (
            list(headers.items()) if isinstance(headers, Mapping) else headers
        )
        lowered: dict[str, str] = {}
        seen_agentgate: set[str] = set()
        for raw_key, raw_val in pairs:
            lower_key = raw_key.lower()
            if lower_key.startswith("x-agentgate-"):
                if lower_key in seen_agentgate:
                    return HttpResponse(
                        status_code=400,
                        body={"detail": f"Duplicate header not allowed: {raw_key}."},
                    )
                if lower_key in _SECURITY_HEADERS and "," in raw_val:
                    return HttpResponse(
                        status_code=400,
                        body={"detail": f"Duplicate header values not allowed: {raw_key}."},
                    )
                seen_agentgate.add(lower_key)
            lowered[lower_key] = raw_val

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
        if (
            not raw_timestamp
            or len(raw_timestamp) > 15
            or not raw_timestamp.isascii()
            or not raw_timestamp.isdigit()
        ):
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

        try:
            decision = ingest_webhook(
                event=event,
                signature_header=signature,
                secret=self._config.webhook_secret,
                store=self._store,
                now_timestamp=self._now_fn(),
                max_age_seconds=self._config.max_age_seconds,
                idempotency_ttl_seconds=self._config.idempotency_ttl_seconds,
                allow_legacy_v1=self._config.allow_legacy_v1,
            )
        except Exception:
            _LOGGER.exception("Idempotency store claim failed during webhook ingestion.")
            return HttpResponse(
                status_code=503,
                body={"detail": "Idempotency store unavailable."},
            )

        if decision.status == "accepted" and self._triage_runner is not None:
            try:
                triage_output = self._triage_runner(event)
            except Exception:
                _LOGGER.exception("Triage runner failed; releasing idempotency key.")
                try:
                    self._store.release(event.idempotency_key)
                except Exception:
                    _LOGGER.exception("Failed releasing idempotency key after triage error.")
                return HttpResponse(
                    status_code=503,
                    body={"detail": "Triage execution failed; idempotency key released for retry."},
                )
            decision = decision.model_copy(update={"triage": triage_output})

        status_code = 200 if decision.status in ("accepted", "duplicate") else 401
        response_body: dict[str, JsonValue] = {
            "status": decision.status,
            "idempotency_key": decision.idempotency_key,
            "reason": decision.reason,
        }
        if decision.triage is not None:
            response_body["triage"] = decision.triage.model_dump(mode="json")

        return HttpResponse(status_code=status_code, body=response_body)


def _load_dynamodb_table(table_name: str, region_name: str | None) -> DynamoDbTableProtocol:
    boto3_module: object = importlib.import_module("boto3")
    if not isinstance(boto3_module, _Boto3ModuleProtocol):
        raise RuntimeError("Loaded boto3 module does not expose resource().")
    resource: object = boto3_module.resource("dynamodb", region_name=region_name)
    if not isinstance(resource, _DynamoDbResourceProtocol):
        raise RuntimeError("DynamoDB resource does not expose Table().")
    table: object = resource.Table(table_name)
    if not isinstance(table, DynamoDbTableProtocol):
        raise RuntimeError("DynamoDB Table resource does not expose put_item()/delete_item().")
    return table


def _parse_int_env(env: Mapping[str, str], key: str, default: int) -> int:
    raw = env.get(key, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"{key} must be an integer, got {raw!r}.") from exc


def _parse_bool_env(env: Mapping[str, str], key: str, default: bool) -> bool:
    raw = env.get(key, "").strip().lower()
    if not raw:
        return default
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{key} must be a boolean value, got {raw!r}.")


def create_ingress_from_env(
    env: Mapping[str, str],
    *,
    now_fn: Callable[[], int] | None = None,
    dynamodb_table: DynamoDbTableProtocol | None = None,
    triage_runner: Callable[[WebhookEvent], AgentOutput] | None = None,
) -> WebhookIngress:
    """Build a configured WebhookIngress and IdempotencyStore from environment variables."""
    secret = env.get("AGENTGATE_WEBHOOK_SECRET", "").strip()
    if not secret:
        raise ValueError("AGENTGATE_WEBHOOK_SECRET must be set.")

    raw_triage_mode = env.get("AGENTGATE_TRIAGE_MODE", "none").strip().lower() or "none"
    if raw_triage_mode not in ("none", "deterministic"):
        raise ValueError(f"Unsupported AGENTGATE_TRIAGE_MODE: {raw_triage_mode!r}.")
    triage_mode: Literal["none", "deterministic"] = (
        "deterministic" if raw_triage_mode == "deterministic" else "none"
    )

    config = IngressConfig(
        webhook_secret=secret,
        max_age_seconds=_parse_int_env(env, "AGENTGATE_WEBHOOK_MAX_AGE_SECONDS", 300),
        idempotency_ttl_seconds=_parse_int_env(env, "AGENTGATE_IDEMPOTENCY_TTL_SECONDS", 86400),
        allow_legacy_v1=_parse_bool_env(env, "AGENTGATE_ALLOW_LEGACY_V1", False),
        max_body_bytes=_parse_int_env(env, "AGENTGATE_MAX_BODY_BYTES", 1_048_576),
        triage_mode=triage_mode,
    )

    backend = env.get("AGENTGATE_STORE_BACKEND", "sqlite").strip().lower() or "sqlite"
    store: IdempotencyStore
    if backend == "sqlite":
        db_path = env.get("AGENTGATE_SQLITE_PATH", "").strip() or "./data/agentgate.db"
        store = SqliteIdempotencyStore(db_path=db_path, now_fn=now_fn)
    elif backend == "memory":
        store = InMemoryIdempotencyStore(now_fn=now_fn)
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

    return WebhookIngress(
        config=config,
        store=store,
        now_fn=now_fn,
        triage_runner=triage_runner,
    )
