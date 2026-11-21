"""HMAC-SHA256 webhook verification, replay protection, and idempotent intake."""

import hashlib
import hmac

from agentgate.seams import IdempotencyStore
from agentgate.types import IntakeDecision, WebhookEvent

_HEX_CHARS = frozenset("0123456789abcdefABCDEF")


def _is_valid_sha256_hex(value: str) -> bool:
    return len(value) == 64 and all(ch in _HEX_CHARS for ch in value)


def sign_payload(
    secret: str,
    timestamp: int,
    raw_body: bytes,
    *,
    idempotency_key: str | None = None,
) -> str:
    """Compute a versioned HMAC-SHA256 signature (`v2=` key-bound, or legacy `v1=`)."""
    if not secret:
        raise ValueError("Webhook signing secret must not be empty.")
    if idempotency_key is not None:
        if not idempotency_key:
            raise ValueError("idempotency_key must not be empty when provided.")
        signed_bytes = f"{timestamp}.{idempotency_key}.".encode() + raw_body
        prefix = "v2="
    else:
        signed_bytes = f"{timestamp}.".encode() + raw_body
        prefix = "v1="
    digest = hmac.new(secret.encode("utf-8"), signed_bytes, hashlib.sha256).hexdigest()
    return f"{prefix}{digest}"


def verify_signature(
    secret: str,
    timestamp: int,
    raw_body: bytes,
    signature_header: str,
    *,
    idempotency_key: str | None = None,
    allow_legacy_v1: bool = False,
) -> bool:
    """Verify HMAC-SHA256 webhook signature (`v2=` or opt-in legacy `v1=`) in constant time."""
    if not secret or not signature_header or "=" not in signature_header:
        return False
    scheme, raw_digest = signature_header.split("=", 1)
    if not _is_valid_sha256_hex(raw_digest):
        return False
    normalized_digest = raw_digest.lower()

    if scheme == "v2":
        if not idempotency_key:
            return False
        expected = sign_payload(
            secret=secret,
            timestamp=timestamp,
            raw_body=raw_body,
            idempotency_key=idempotency_key,
        )
        return hmac.compare_digest(expected.split("=", 1)[1], normalized_digest)

    if scheme == "v1":
        if not allow_legacy_v1:
            return False
        expected = sign_payload(
            secret=secret,
            timestamp=timestamp,
            raw_body=raw_body,
            idempotency_key=None,
        )
        return hmac.compare_digest(expected.split("=", 1)[1], normalized_digest)

    return False


def ingest_webhook(
    event: WebhookEvent,
    signature_header: str,
    secret: str,
    store: IdempotencyStore,
    now_timestamp: int,
    max_age_seconds: int = 300,
    idempotency_ttl_seconds: int = 86400,
    *,
    allow_legacy_v1: bool = False,
) -> IntakeDecision:
    """Authenticate, check replay window, and atomically claim webhook idempotency key."""
    if now_timestamp < 0:
        raise ValueError("now_timestamp must be non-negative.")
    if max_age_seconds < 0:
        raise ValueError("max_age_seconds must be non-negative.")
    if idempotency_ttl_seconds <= 0:
        raise ValueError("idempotency_ttl_seconds must be positive.")

    # Verify HMAC before replay-window checks so unauthenticated callers cannot probe clock skew.
    if not verify_signature(
        secret=secret,
        timestamp=event.timestamp,
        raw_body=event.raw_body,
        signature_header=signature_header,
        idempotency_key=event.idempotency_key,
        allow_legacy_v1=allow_legacy_v1,
    ):
        return IntakeDecision(
            status="rejected_signature",
            idempotency_key=event.idempotency_key,
            reason="Invalid or malformed HMAC-SHA256 signature.",
        )

    is_stale = (now_timestamp - event.timestamp) > max_age_seconds
    is_future_skewed = (event.timestamp - now_timestamp) > min(60, max_age_seconds)
    if is_stale or is_future_skewed:
        return IntakeDecision(
            status="rejected_stale",
            idempotency_key=event.idempotency_key,
            reason="Timestamp outside allowed replay window.",
        )

    claimed = store.claim(event.idempotency_key, ttl_seconds=idempotency_ttl_seconds)
    if not claimed:
        return IntakeDecision(
            status="duplicate",
            idempotency_key=event.idempotency_key,
            reason="Idempotency key already claimed; duplicate delivery skipped.",
        )

    return IntakeDecision(
        status="accepted",
        idempotency_key=event.idempotency_key,
        reason="Webhook authenticated and idempotency key claimed.",
    )
