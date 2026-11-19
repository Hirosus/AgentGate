"""Tests for shared WebhookIngress and FastAPI ASGI HTTP routes."""

from collections.abc import Mapping
from pathlib import Path

import httpx
import pytest

from agentgate.api import create_app, create_app_from_env
from agentgate.client import AsyncAgentGateClient
from agentgate.ingress import IngressConfig, create_ingress_from_env
from agentgate.seams import InMemoryIdempotencyStore
from agentgate.stores import SqliteIdempotencyStore
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
                    "X-AgentGate-Signature": "v1=deadbeef",
                },
            )
            assert bad_sig_res.status_code == 401
            assert bad_sig_res.json()["status"] == "rejected_signature"

            stale_ts = 1_699_999_000
            stale_sig = sign_payload("top-secret", stale_ts, raw)
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

            fresh_sig = sign_payload("top-secret", 1_700_000_000, raw)
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
    valid_sig = sign_payload("top-secret", 1_700_000_000, raw)

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

    mem_ingress = create_ingress_from_env(
        {
            "AGENTGATE_WEBHOOK_SECRET": "env-secret",
            "AGENTGATE_STORE_BACKEND": "memory",
        },
        now_fn=lambda: 1_700_000_010,
    )
    raw = b'{"ok":true}'
    sig = sign_payload("env-secret", 1_700_000_005, raw)
    mem_res = mem_ingress.handle_triage_webhook(
        {
            "X-AgentGate-Idempotency-Key": "evt-mem",
            "X-AgentGate-Timestamp": "1700000005",
            "X-AgentGate-Signature": sig,
        },
        raw,
    )
    assert mem_res.status_code == 200
    assert mem_res.body["status"] == "accepted"

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
    ddb_res = ddb_ingress.handle_triage_webhook(
        {
            "X-AgentGate-Idempotency-Key": "evt-ddb",
            "X-AgentGate-Timestamp": "1700000005",
            "X-AgentGate-Signature": sig,
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
