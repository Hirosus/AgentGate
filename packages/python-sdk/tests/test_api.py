"""Tests for shared WebhookIngress and FastAPI ASGI HTTP routes."""

from collections.abc import Mapping
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from agentgate.api import create_app, create_app_from_env
from agentgate.client import AgentGateClient, AsyncAgentGateClient
from agentgate.ingress import IngressConfig, WebhookIngress, create_ingress_from_env
from agentgate.seams import InMemoryIdempotencyStore
from agentgate.stores import SqliteIdempotencyStore
from agentgate.types import AgentOutput, WebhookEvent
from agentgate.webhook import sign_payload


class _FakeTable:
    def __init__(self) -> None:
        self.items: dict[str, dict[str, str | int]] = {}

    def put_item(
        self,
        *,
        Item: Mapping[str, str | int],
        ConditionExpression: str,
        ExpressionAttributeNames: Mapping[str, str],
        ExpressionAttributeValues: Mapping[str, int],
    ) -> object:
        key = Item["idempotency_key"]
        expires_at = Item["expires_at"]
        assert isinstance(key, str)
        assert isinstance(expires_at, int)
        self.items[key] = {"idempotency_key": key, "expires_at": expires_at}
        return {}

    def delete_item(self, *, Key: Mapping[str, str]) -> object:
        self.items.pop(Key["idempotency_key"], None)
        return {}


async def test_async_sdk_client_end_to_end_against_fastapi_and_sqlite(tmp_path: Path) -> None:
    raw = b'{\n  "z": 1,  "a": 2\n}'
    with SqliteIdempotencyStore(tmp_path / "ingress.db", now_fn=lambda: 1_700_000_010) as store:
        app = create_app(
            config=IngressConfig(webhook_secret="top-secret"),
            store=store,
            now_fn=lambda: 1_700_000_010,
        )
        transport = httpx.ASGITransport(app=app)
        async with AsyncAgentGateClient(
            "http://testserver",
            "top-secret",
            transport=transport,
        ) as client:
            assert await client.health() is True
            first = await client.send_signed_webhook("evt-api-1", 1_700_000_005, raw)
            second = await client.send_signed_webhook("evt-api-1", 1_700_000_006, raw)

    assert first.status == "accepted"
    assert second.status == "duplicate"


async def test_fastapi_rejects_bad_signature_and_stale_timestamp_without_claiming(
    tmp_path: Path,
) -> None:
    raw = b'{"alert":"db_pool"}'
    with SqliteIdempotencyStore(tmp_path / "auth.db", now_fn=lambda: 1_700_000_010) as store:
        app = create_app(
            config=IngressConfig(webhook_secret="top-secret", max_age_seconds=300),
            store=store,
            now_fn=lambda: 1_700_000_010,
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
        ) as http:
            bad_sig_res = await http.post(
                "/webhooks/triage",
                content=raw,
                headers={
                    "X-AgentGate-Idempotency-Key": "evt-auth-1",
                    "X-AgentGate-Timestamp": "1700000000",
                    "X-AgentGate-Signature": "v2=deadbeef",
                },
            )
            assert bad_sig_res.status_code == 401
            assert bad_sig_res.json()["status"] == "rejected_signature"

            stale_ts = 1_699_999_000
            stale_sig = sign_payload(
                "top-secret", stale_ts, raw, idempotency_key="evt-auth-1"
            )
            stale_res = await http.post(
                "/webhooks/triage",
                content=raw,
                headers={
                    "X-AgentGate-Idempotency-Key": "evt-auth-1",
                    "X-AgentGate-Timestamp": str(stale_ts),
                    "X-AgentGate-Signature": stale_sig,
                },
            )
            assert stale_res.status_code == 401
            assert stale_res.json()["status"] == "rejected_stale"

            fresh_sig = sign_payload(
                "top-secret", 1_700_000_000, raw, idempotency_key="evt-auth-1"
            )
            ok_res = await http.post(
                "/webhooks/triage",
                content=raw,
                headers={
                    "x-AgentGate-Idempotency-Key": "evt-auth-1",
                    "X-AGENTGATE-TIMESTAMP": "1700000000",
                    "x-agentgate-signature": fresh_sig,
                },
            )
            assert ok_res.status_code == 200
            assert ok_res.json()["status"] == "accepted"


async def test_fastapi_returns_400_for_missing_or_malformed_headers() -> None:
    store = InMemoryIdempotencyStore(current_time=1_700_000_010)
    app = create_app(
        config=IngressConfig(webhook_secret="top-secret"),
        store=store,
        now_fn=lambda: 1_700_000_010,
    )
    raw = b'{"alert":"ping"}'
    valid_sig = sign_payload("top-secret", 1_700_000_000, raw, idempotency_key="evt-400")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
    ) as http:
        missing_key = await http.post(
            "/webhooks/triage",
            content=raw,
            headers={
                "X-AgentGate-Timestamp": "1700000000",
                "X-AgentGate-Signature": valid_sig,
            },
        )
        assert missing_key.status_code == 400
        assert "detail" in missing_key.json()

        missing_sig = await http.post(
            "/webhooks/triage",
            content=raw,
            headers={
                "X-AgentGate-Idempotency-Key": "evt-400",
                "X-AgentGate-Timestamp": "1700000000",
            },
        )
        assert missing_sig.status_code == 400
        assert "detail" in missing_sig.json()

        missing_ts = await http.post(
            "/webhooks/triage",
            content=raw,
            headers={
                "X-AgentGate-Idempotency-Key": "evt-400",
                "X-AgentGate-Signature": valid_sig,
            },
        )
        assert missing_ts.status_code == 400
        assert "detail" in missing_ts.json()

        bad_ts = await http.post(
            "/webhooks/triage",
            content=raw,
            headers={
                "X-AgentGate-Idempotency-Key": "evt-400",
                "X-AgentGate-Timestamp": "not-a-number",
                "X-AgentGate-Signature": valid_sig,
            },
        )
        assert bad_ts.status_code == 400
        assert "detail" in bad_ts.json()

        neg_ts = await http.post(
            "/webhooks/triage",
            content=raw,
            headers={
                "X-AgentGate-Idempotency-Key": "evt-400",
                "X-AgentGate-Timestamp": "-5",
                "X-AgentGate-Signature": valid_sig,
            },
        )
        assert neg_ts.status_code == 400
        assert "detail" in neg_ts.json()

        valid_after = await http.post(
            "/webhooks/triage",
            content=raw,
            headers={
                "X-AgentGate-Idempotency-Key": "evt-400",
                "X-AgentGate-Timestamp": "1700000000",
                "X-AgentGate-Signature": valid_sig,
            },
        )
        assert valid_after.status_code == 200
        assert valid_after.json()["status"] == "accepted"


def test_create_ingress_from_env_supports_sqlite_memory_and_dynamodb(tmp_path: Path) -> None:
    sqlite_path = tmp_path / "env.db"
    sqlite_ingress = create_ingress_from_env(
        {
            "AGENTGATE_WEBHOOK_SECRET": "env-secret",
            "AGENTGATE_STORE_BACKEND": "sqlite",
            "AGENTGATE_SQLITE_PATH": str(sqlite_path),
        },
        now_fn=lambda: 1_700_000_010,
    )
    try:
        assert sqlite_path.exists()
        assert sqlite_ingress.handle_health().status_code == 200
    finally:
        sqlite_ingress.close()

    mem_clock = [1_700_000_010]
    mem_ingress = create_ingress_from_env(
        {
            "AGENTGATE_WEBHOOK_SECRET": "env-secret",
            "AGENTGATE_STORE_BACKEND": "memory",
            "AGENTGATE_IDEMPOTENCY_TTL_SECONDS": "300",
            "AGENTGATE_WEBHOOK_MAX_AGE_SECONDS": "300",
        },
        now_fn=lambda: mem_clock[0],
    )
    raw = b'{"ok":true}'
    mem_sig = sign_payload("env-secret", 1_700_000_005, raw, idempotency_key="evt-mem")
    mem_res = mem_ingress.handle_triage_webhook(
        {
            "X-AgentGate-Idempotency-Key": "evt-mem",
            "X-AgentGate-Timestamp": "1700000005",
            "X-AgentGate-Signature": mem_sig,
        },
        raw,
    )
    assert mem_res.status_code == 200
    assert mem_res.body["status"] == "accepted"

    # Memory backend uses live now_fn rather than frozen initial_time, so TTL advances.
    mem_clock[0] = 1_700_000_315
    mem_sig_2 = sign_payload("env-secret", 1_700_000_315, raw, idempotency_key="evt-mem")
    mem_res_2 = mem_ingress.handle_triage_webhook(
        {
            "X-AgentGate-Idempotency-Key": "evt-mem",
            "X-AgentGate-Timestamp": "1700000315",
            "X-AgentGate-Signature": mem_sig_2,
        },
        raw,
    )
    assert mem_res_2.status_code == 200
    assert mem_res_2.body["status"] == "accepted"

    fake_table = _FakeTable()
    ddb_ingress = create_ingress_from_env(
        {
            "AGENTGATE_WEBHOOK_SECRET": "env-secret",
            "AGENTGATE_STORE_BACKEND": "dynamodb",
            "IDEMPOTENCY_TABLE": "claims-table",
        },
        now_fn=lambda: 1_700_000_010,
        dynamodb_table=fake_table,
    )
    ddb_sig = sign_payload("env-secret", 1_700_000_005, raw, idempotency_key="evt-ddb")
    ddb_res = ddb_ingress.handle_triage_webhook(
        {
            "X-AgentGate-Idempotency-Key": "evt-ddb",
            "X-AgentGate-Timestamp": "1700000005",
            "X-AgentGate-Signature": ddb_sig,
        },
        raw,
    )
    assert ddb_res.status_code == 200
    assert "evt-ddb" in fake_table.items

    with pytest.raises(ValueError):
        create_ingress_from_env({})

    with pytest.raises(ValueError):
        create_ingress_from_env(
            {
                "AGENTGATE_WEBHOOK_SECRET": "env-secret",
                "AGENTGATE_STORE_BACKEND": "postgres",
            }
        )


async def test_create_app_from_env_serves_health() -> None:
    app = create_app_from_env(
        {
            "AGENTGATE_WEBHOOK_SECRET": "env-secret",
            "AGENTGATE_STORE_BACKEND": "memory",
        }
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
    ) as http:
        res = await http.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_fastapi_lifespan_closes_store_and_enforces_413_400_and_triage_rollback(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "lifespan.db"
    store = SqliteIdempotencyStore(db_path=db_path, now_fn=lambda: 1_700_000_010)
    app = create_app(
        config=IngressConfig(
            webhook_secret="top-secret",
            max_body_bytes=128,
            triage_mode="deterministic",
        ),
        store=store,
        now_fn=lambda: 1_700_000_010,
    )

    with TestClient(app) as client:
        assert client.get("/health").status_code == 200

        oversized = b"x" * 129
        res_413 = client.post(
            "/webhooks/triage",
            content=oversized,
            headers={
                "X-AgentGate-Idempotency-Key": "evt-413",
                "X-AgentGate-Timestamp": "1700000010",
                "X-AgentGate-Signature": sign_payload(
                    "top-secret", 1_700_000_010, oversized, idempotency_key="evt-413"
                ),
            },
        )
        assert res_413.status_code == 413

        huge_ts = "9" * 5000
        res_huge_ts = client.post(
            "/webhooks/triage",
            content=b"{}",
            headers={
                "X-AgentGate-Idempotency-Key": "evt-huge-ts",
                "X-AgentGate-Timestamp": huge_ts,
                "X-AgentGate-Signature": "v2=" + ("aa" * 32),
            },
        )
        assert res_huge_ts.status_code == 400

        dup_headers = client.post(
            "/webhooks/triage",
            content=b"{}",
            headers=[
                ("X-AgentGate-Idempotency-Key", "evt-dup-hdr"),
                ("X-AgentGate-Timestamp", "1700000010"),
                ("X-AgentGate-Signature", "v2=" + ("aa" * 32)),
                ("X-AgentGate-Signature", "v2=" + ("bb" * 32)),
            ],
        )
        assert dup_headers.status_code == 400

        alert_raw = b'{"service":"checkout-api","p95_ms":820,"msg":"SELECT FOR UPDATE"}'
        sig = sign_payload(
            "top-secret", 1_700_000_010, alert_raw, idempotency_key="evt-triage-1"
        )
        ok = client.post(
            "/webhooks/triage",
            content=alert_raw,
            headers={
                "X-AgentGate-Idempotency-Key": "evt-triage-1",
                "X-AgentGate-Timestamp": "1700000010",
                "X-AgentGate-Signature": sig,
            },
        )
        assert ok.status_code == 200
        body = ok.json()
        assert body["status"] == "accepted"
        assert body["triage"]["severity"] == "high"
        assert body["triage"]["recommended_runbook"] == "rb-latency-pool"

    # Exiting TestClient triggers FastAPI lifespan shutdown, closing SQLite store.
    with pytest.raises(RuntimeError, match="closed"):
        store.claim("after-close", ttl_seconds=60)


def test_ingress_triage_failure_releases_key_and_store_outage_returns_503() -> None:
    store = InMemoryIdempotencyStore(current_time=1_700_000_010)
    attempts = 0

    def flaky_triage(_event: WebhookEvent) -> AgentOutput:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("upstream triage timeout")
        return AgentOutput(
            severity="medium",
            category="auth_failure",
            summary="Recovered on retry",
            recommended_runbook="rb-hmac-rotation",
        )

    ingress = WebhookIngress(
        config=IngressConfig(webhook_secret="top-secret"),
        store=store,
        now_fn=lambda: 1_700_000_010,
        triage_runner=flaky_triage,
    )
    raw = b'{"alert":"retry-test"}'
    sig = sign_payload("top-secret", 1_700_000_010, raw, idempotency_key="evt-retry-1")
    headers = {
        "X-AgentGate-Idempotency-Key": "evt-retry-1",
        "X-AgentGate-Timestamp": "1700000010",
        "X-AgentGate-Signature": sig,
    }

    first = ingress.handle_triage_webhook(headers, raw)
    assert first.status_code == 503

    # Key was released on failure so retry is accepted rather than marked duplicate.
    second = ingress.handle_triage_webhook(headers, raw)
    assert second.status_code == 200
    assert second.body["status"] == "accepted"
    assert isinstance(second.body["triage"], dict)
    assert second.body["triage"]["recommended_runbook"] == "rb-hmac-rotation"

    class _DownStore:
        def claim(self, key: str, ttl_seconds: int) -> bool:
            del key, ttl_seconds
            raise ConnectionError("dynamodb unavailable")

        def release(self, key: str) -> None:
            del key

    down_ingress = WebhookIngress(
        config=IngressConfig(webhook_secret="top-secret"),
        store=_DownStore(),
        now_fn=lambda: 1_700_000_010,
    )
    down_res = down_ingress.handle_triage_webhook(headers, raw)
    assert down_res.status_code == 503
    assert down_res.body == {"detail": "Idempotency store unavailable."}


async def test_ingress_config_and_client_validation_and_non_raising_401() -> None:
    with pytest.raises(ValueError):
        IngressConfig(webhook_secret="sec", max_age_seconds=600, idempotency_ttl_seconds=300)
    with pytest.raises(ValueError):
        AgentGateClient("https://agentgate.local", "")
    with pytest.raises(ValueError):
        AsyncAgentGateClient("https://agentgate.local", "")

    with AgentGateClient(
        "https://agentgate.local",
        "wrong-secret",
        transport=httpx.MockTransport(
            lambda _req: httpx.Response(
                401,
                json={
                    "status": "rejected_signature",
                    "idempotency_key": "evt-sync-401",
                    "reason": "Invalid or malformed HMAC-SHA256 signature.",
                },
            )
        ),
    ) as sync_sdk:
        sync_decision = sync_sdk.send_signed_webhook(
            "evt-sync-401",
            1_700_000_010,
            b"{}",
            source="ci-smoke",
            raise_on_rejected=False,
        )
        assert sync_decision.status == "rejected_signature"

    store = InMemoryIdempotencyStore(current_time=1_700_000_010)
    app = create_app(
        config=IngressConfig(webhook_secret="right-secret"),
        store=store,
        now_fn=lambda: 1_700_000_010,
    )
    async with AsyncAgentGateClient(
        "http://testserver",
        "wrong-secret",
        transport=httpx.ASGITransport(app=app),
    ) as async_sdk:
        decision = await async_sdk.send_signed_webhook(
            "evt-401",
            1_700_000_010,
            b"{}",
            source="ci-smoke",
            raise_on_rejected=False,
        )
        assert decision.status == "rejected_signature"
        assert decision.triage is None
