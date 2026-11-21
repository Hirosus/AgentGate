"""Tests for HMAC signature verification, replay rejection, and idempotent intake."""

import pytest

from agentgate.seams import InMemoryIdempotencyStore
from agentgate.types import WebhookEvent
from agentgate.webhook import ingest_webhook, sign_payload, verify_signature


def test_sign_and_verify_roundtrip() -> None:
    secret = "test-secret-key"
    raw = b'{"alert":"p95_latency","service":"checkout"}'
    sig = sign_payload(
        secret=secret,
        timestamp=1_700_000_000,
        raw_body=raw,
        idempotency_key="evt-100",
    )
    assert sig.startswith("v2=")

    assert verify_signature(secret, 1_700_000_000, raw, sig, idempotency_key="evt-100") is True
    upper_sig = sig.upper().replace("V2=", "v2=")
    assert (
        verify_signature(secret, 1_700_000_000, raw, upper_sig, idempotency_key="evt-100") is True
    )
    assert verify_signature(secret, 1_700_000_000, raw, sig, idempotency_key="evt-other") is False
    assert verify_signature(secret, 1_700_000_000, raw, sig, idempotency_key=None) is False
    assert verify_signature(secret, 1_700_000_000, b"{}", sig, idempotency_key="evt-100") is False
    assert verify_signature(secret, 1_700_000_001, raw, sig, idempotency_key="evt-100") is False
    assert (
        verify_signature(secret, 1_700_000_000, raw, "bad-header", idempotency_key="evt-100")
        is False
    )


def test_ingest_accepts_then_rejects_duplicate() -> None:
    store = InMemoryIdempotencyStore(current_time=1_700_000_010)
    raw = b'{"incident":"INC-101"}'
    event = WebhookEvent(idempotency_key="evt-101", timestamp=1_700_000_000, raw_body=raw)
    sig = sign_payload("top-secret", event.timestamp, raw, idempotency_key=event.idempotency_key)

    first = ingest_webhook(event, sig, "top-secret", store, now_timestamp=1_700_000_010)
    second = ingest_webhook(event, sig, "top-secret", store, now_timestamp=1_700_000_020)

    assert first.status == "accepted"
    assert second.status == "duplicate"


def test_ingest_allows_key_after_ttl_expiry() -> None:
    store = InMemoryIdempotencyStore(current_time=1_700_000_000)
    raw = b'{"incident":"INC-102"}'
    event = WebhookEvent(idempotency_key="evt-102", timestamp=1_700_000_000, raw_body=raw)
    sig = sign_payload("secret", event.timestamp, raw, idempotency_key=event.idempotency_key)

    first = ingest_webhook(
        event, sig, "secret", store, now_timestamp=1_700_000_000, idempotency_ttl_seconds=60
    )
    store.advance_time(61)
    fresh_event = WebhookEvent(idempotency_key="evt-102", timestamp=1_700_000_061, raw_body=raw)
    fresh_sig = sign_payload(
        "secret", fresh_event.timestamp, raw, idempotency_key=fresh_event.idempotency_key
    )
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
    stale_sig = sign_payload(
        "secret", stale_event.timestamp, raw, idempotency_key=stale_event.idempotency_key
    )

    stale_decision = ingest_webhook(
        stale_event, stale_sig, "secret", store, now_timestamp=1_700_001_000, max_age_seconds=300
    )
    assert stale_decision.status == "rejected_stale"
    assert stale_decision.reason == "Timestamp outside allowed replay window."

    # Bad signature with a stale timestamp must not leak replay-window oracle details.
    bad_sig_stale = ingest_webhook(
        stale_event, "v2=" + ("ab" * 32), "secret", store, now_timestamp=1_700_001_000
    )
    assert bad_sig_stale.status == "rejected_signature"

    fresh_event = WebhookEvent(idempotency_key="evt-103", timestamp=1_700_001_000, raw_body=raw)
    bad_sig_decision = ingest_webhook(
        fresh_event, "v2=deadbeef", "secret", store, now_timestamp=1_700_001_000
    )
    assert bad_sig_decision.status == "rejected_signature"


def test_legacy_v1_opt_in_and_future_timestamp_rejection() -> None:
    store = InMemoryIdempotencyStore(current_time=1_700_000_000)
    raw = b'{"incident":"INC-104"}'
    event = WebhookEvent(idempotency_key="evt-104", timestamp=1_700_000_000, raw_body=raw)
    legacy_sig = sign_payload("secret", event.timestamp, raw)
    assert legacy_sig.startswith("v1=")

    assert verify_signature("secret", event.timestamp, raw, legacy_sig) is False
    assert (
        verify_signature("secret", event.timestamp, raw, legacy_sig, allow_legacy_v1=True)
        is True
    )

    rejected = ingest_webhook(event, legacy_sig, "secret", store, now_timestamp=1_700_000_000)
    assert rejected.status == "rejected_signature"

    accepted = ingest_webhook(
        event,
        legacy_sig,
        "secret",
        store,
        now_timestamp=1_700_000_000,
        allow_legacy_v1=True,
    )
    assert accepted.status == "accepted"

    future_event = WebhookEvent(idempotency_key="evt-future", timestamp=1_700_000_120, raw_body=raw)
    future_sig = sign_payload(
        "secret", future_event.timestamp, raw, idempotency_key=future_event.idempotency_key
    )
    future_decision = ingest_webhook(
        future_event, future_sig, "secret", store, now_timestamp=1_700_000_000, max_age_seconds=300
    )
    assert future_decision.status == "rejected_stale"
    assert future_decision.reason == "Timestamp outside allowed replay window."


def test_webhook_signing_and_ingest_bounds_validation() -> None:
    with pytest.raises(ValueError):
        sign_payload("", 1_700_000_000, b"{}", idempotency_key="k")
    with pytest.raises(ValueError):
        sign_payload("sec", 1_700_000_000, b"{}", idempotency_key="")

    store = InMemoryIdempotencyStore(current_time=1_700_000_000)
    event = WebhookEvent(idempotency_key="evt-bounds", timestamp=1_700_000_000, raw_body=b"{}")
    sig = sign_payload("sec", event.timestamp, b"{}", idempotency_key=event.idempotency_key)

    with pytest.raises(ValueError):
        ingest_webhook(event, sig, "sec", store, now_timestamp=-1)
    with pytest.raises(ValueError):
        ingest_webhook(event, sig, "sec", store, now_timestamp=1_700_000_000, max_age_seconds=-5)
    with pytest.raises(ValueError):
        ingest_webhook(
            event, sig, "sec", store, now_timestamp=1_700_000_000, idempotency_ttl_seconds=0
        )
