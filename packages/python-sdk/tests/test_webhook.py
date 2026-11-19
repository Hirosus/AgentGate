"""Tests for HMAC signature verification, replay rejection, and idempotent intake."""

from agentgate.seams import InMemoryIdempotencyStore
from agentgate.types import WebhookEvent
from agentgate.webhook import ingest_webhook, sign_payload, verify_signature


def test_sign_and_verify_roundtrip() -> None:
    secret = "test-secret-key"
    raw = b'{"alert":"p95_latency","service":"checkout"}'
    sig = sign_payload(secret=secret, timestamp=1_700_000_000, raw_body=raw)

    assert verify_signature(secret, 1_700_000_000, raw, sig) is True
    assert verify_signature(secret, 1_700_000_000, b"{}", sig) is False
    assert verify_signature(secret, 1_700_000_001, raw, sig) is False
    assert verify_signature(secret, 1_700_000_000, raw, "bad-header") is False


def test_ingest_accepts_then_rejects_duplicate() -> None:
    store = InMemoryIdempotencyStore(current_time=1_700_000_010)
    raw = b'{"incident":"INC-101"}'
    event = WebhookEvent(idempotency_key="evt-101", timestamp=1_700_000_000, raw_body=raw)
    sig = sign_payload("top-secret", event.timestamp, raw)

    first = ingest_webhook(event, sig, "top-secret", store, now_timestamp=1_700_000_010)
    second = ingest_webhook(event, sig, "top-secret", store, now_timestamp=1_700_000_020)

    assert first.status == "accepted"
    assert second.status == "duplicate"


def test_ingest_allows_key_after_ttl_expiry() -> None:
    store = InMemoryIdempotencyStore(current_time=1_700_000_000)
    raw = b'{"incident":"INC-102"}'
    event = WebhookEvent(idempotency_key="evt-102", timestamp=1_700_000_000, raw_body=raw)
    sig = sign_payload("secret", event.timestamp, raw)

    first = ingest_webhook(
        event, sig, "secret", store, now_timestamp=1_700_000_000, idempotency_ttl_seconds=60
    )
    store.advance_time(61)
    fresh_event = WebhookEvent(idempotency_key="evt-102", timestamp=1_700_000_061, raw_body=raw)
    fresh_sig = sign_payload("secret", fresh_event.timestamp, raw)
    replayed = ingest_webhook(
        fresh_event,
        fresh_sig,
        "secret",
        store,
        now_timestamp=1_700_000_061,
        idempotency_ttl_seconds=60,
    )

    assert first.status == "accepted"
    assert replayed.status == "accepted"


def test_ingest_rejects_stale_and_bad_signature() -> None:
    store = InMemoryIdempotencyStore(current_time=1_700_001_000)
    raw = b'{"incident":"INC-103"}'
    stale_event = WebhookEvent(idempotency_key="evt-103", timestamp=1_700_000_000, raw_body=raw)
    stale_sig = sign_payload("secret", stale_event.timestamp, raw)

    stale_decision = ingest_webhook(
        stale_event, stale_sig, "secret", store, now_timestamp=1_700_001_000, max_age_seconds=300
    )
    assert stale_decision.status == "rejected_stale"

    fresh_event = WebhookEvent(idempotency_key="evt-103", timestamp=1_700_001_000, raw_body=raw)
    bad_sig_decision = ingest_webhook(
        fresh_event, "v1=deadbeef", "secret", store, now_timestamp=1_700_001_000
    )
    assert bad_sig_decision.status == "rejected_signature"
