"""HMAC-SHA256 webhook verification, replay protection, and idempotent intake."""

import hashlib
import hmac

from agentgate.seams import IdempotencyStore
from agentgate.types import IntakeDecision, WebhookEvent

_SIG_PREFIX = "v1="


def sign_payload(secret: str, timestamp: int, raw_body: bytes) -> str:
    """Compute a versioned HMAC-SHA256 signature for `{timestamp}.{raw_body}`."""
    signed_bytes = f"{timestamp}.".encode() + raw_body
    digest = hmac.new(secret.encode("utf-8"), signed_bytes, hashlib.sha256).hexdigest()
    return f"{_SIG_PREFIX}{digest}"


def verify_signature(secret: str, timestamp: int, raw_body: bytes, header_value: str) -> bool:
    """Verify HMAC-SHA256 webhook signature in constant time."""
    if not secret or not header_value.startswith(_SIG_PREFIX):
        return False
    expected = sign_payload(secret=secret, timestamp=timestamp, raw_body=raw_body)
    return hmac.compare_digest(expected, header_value)


def ingest_webhook(
    event: WebhookEvent,
    signature_header: str,
    secret: str,
    store: IdempotencyStore,
    now_timestamp: int,
    max_age_seconds: int = 300,
    idempotency_ttl_seconds: int = 86400,
) -> IntakeDecision:
    """Authenticate, check replay window, and atomically claim webhook idempotency key."""
    if abs(now_timestamp - event.timestamp) > max_age_seconds:
        return IntakeDecision(
            status="rejected_stale",
            idempotency_key=event.idempotency_key,
            reason=f"Timestamp skew exceeds {max_age_seconds}s replay window.",
        )

    if not verify_signature(
        secret=secret,
        timestamp=event.timestamp,
        raw_body=event.raw_body,
        header_value=signature_header,
    ):
        return IntakeDecision(
            status="rejected_signature",
            idempotency_key=event.idempotency_key,
            reason="Invalid or malformed HMAC-SHA256 signature.",
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
