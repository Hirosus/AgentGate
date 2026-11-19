"""Contract and end-to-end delivery tests for the n8n signed webhook workflow."""

import hashlib
import hmac
import json
import time
from collections.abc import Mapping
from pathlib import Path

import httpx
from pydantic import JsonValue, TypeAdapter

from agentgate.api import create_app_from_env
from agentgate.aws_lambda import build_lambda_handler
from agentgate.ingress import IngressConfig, WebhookIngress
from agentgate.stores import SqliteIdempotencyStore

_REPO_ROOT = Path(__file__).resolve().parents[3]
_WORKFLOW_PATH = _REPO_ROOT / "integrations" / "n8n" / "alert-triage-workflow.json"
_DICT_ADAPTER: TypeAdapter[dict[str, JsonValue]] = TypeAdapter(dict[str, JsonValue])


def _simulate_n8n_envelope(
    payload: Mapping[str, JsonValue],
    *,
    secret: str,
    timestamp: int,
    execution_id: str = "exec-1001",
) -> tuple[dict[str, str], bytes]:
    raw_body_str = json.dumps(payload, separators=(",", ":"))
    raw_body = raw_body_str.encode("utf-8")
    raw_event_id = payload.get("event_id")
    idempotency_key = (
        str(raw_event_id) if raw_event_id is not None else f"n8n-{execution_id}"
    )
    signed_message = f"{timestamp}.{raw_body_str}".encode()
    hex_digest = hmac.new(secret.encode("utf-8"), signed_message, hashlib.sha256).hexdigest()

    headers = {
        "Content-Type": "application/json",
        "X-AgentGate-Source": "n8n",
        "X-AgentGate-Timestamp": str(timestamp),
        "X-AgentGate-Idempotency-Key": idempotency_key,
        "X-AgentGate-Signature": f"v1={hex_digest}",
    }
    return headers, raw_body


def test_n8n_workflow_contract_has_single_timestamp_and_raw_body_signing() -> None:
    raw_text = _WORKFLOW_PATH.read_text(encoding="utf-8")
    assert raw_text.count("$now.toUnixInteger()") == 1

    workflow = _DICT_ADAPTER.validate_json(raw_text)
    raw_nodes = workflow.get("nodes")
    assert isinstance(raw_nodes, list)
    assert len(raw_nodes) == 4

    nodes_by_name: dict[str, dict[str, JsonValue]] = {}
    ordered_names: list[str] = []
    for item in raw_nodes:
        assert isinstance(item, dict)
        name = item.get("name")
        assert isinstance(name, str)
        ordered_names.append(name)
        nodes_by_name[name] = item

    assert ordered_names == [
        "Alert Trigger",
        "Prepare Signing Envelope",
        "Compute HMAC-SHA256",
        "POST to AgentGate Ingress",
    ]

    connections = workflow.get("connections")
    assert isinstance(connections, dict)
    for src_name, dst_name in (
        ("Alert Trigger", "Prepare Signing Envelope"),
        ("Prepare Signing Envelope", "Compute HMAC-SHA256"),
        ("Compute HMAC-SHA256", "POST to AgentGate Ingress"),
    ):
        src_conn = connections.get(src_name)
        assert isinstance(src_conn, dict)
        main_branches = src_conn.get("main")
        assert isinstance(main_branches, list) and isinstance(main_branches[0], list)
        first_target = main_branches[0][0]
        assert isinstance(first_target, dict)
        assert first_target.get("node") == dst_name

    crypto_params = nodes_by_name["Compute HMAC-SHA256"].get("parameters")
    assert isinstance(crypto_params, dict)
    assert crypto_params.get("action") == "hmac"
    assert crypto_params.get("type") == "SHA256"
    assert crypto_params.get("encoding") == "hex"
    assert crypto_params.get("dataPropertyName") == "signature"
    assert crypto_params.get("value") == "={{ $json.timestamp + '.' + $json.rawBody }}"

    http_params = nodes_by_name["POST to AgentGate Ingress"].get("parameters")
    assert isinstance(http_params, dict)
    assert http_params.get("sendBody") is True
    assert http_params.get("contentType") == "raw"
    assert http_params.get("body") == "={{ $json.rawBody }}"

    header_block = http_params.get("headerParameters")
    assert isinstance(header_block, dict)
    raw_header_list = header_block.get("parameters")
    assert isinstance(raw_header_list, list)
    header_names = {
        item["name"] for item in raw_header_list if isinstance(item, dict) and "name" in item
    }
    assert {
        "X-AgentGate-Source",
        "X-AgentGate-Timestamp",
        "X-AgentGate-Idempotency-Key",
        "X-AgentGate-Signature",
    }.issubset(header_names)


async def test_n8n_signed_delivery_roundtrip_against_fastapi_and_sqlite(tmp_path: Path) -> None:
    secret = "n8n-integration-secret-key"
    db_path = tmp_path / "n8n-webhook.db"
    now = int(time.time())

    app = create_app_from_env(
        {
            "AGENTGATE_WEBHOOK_SECRET": secret,
            "AGENTGATE_STORE_BACKEND": "sqlite",
            "AGENTGATE_SQLITE_PATH": str(db_path),
            "AGENTGATE_WEBHOOK_MAX_AGE_SECONDS": "300",
        }
    )

    alert_payload: dict[str, JsonValue] = {
        "event_id": "evt-n8n-001",
        "service": "checkout-api",
        "p95_ms": 820,
    }
    headers, raw_body = _simulate_n8n_envelope(alert_payload, secret=secret, timestamp=now)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://agentgate.local",
    ) as client:
        health = await client.get("/health")
        assert health.status_code == 200
        assert health.json() == {"status": "ok"}

        accepted = await client.post("/webhooks/triage", headers=headers, content=raw_body)
        assert accepted.status_code == 200
        assert accepted.json()["status"] == "accepted"

        duplicate = await client.post("/webhooks/triage", headers=headers, content=raw_body)
        assert duplicate.status_code == 200
        assert duplicate.json()["status"] == "duplicate"

        tampered = await client.post(
            "/webhooks/triage",
            headers={**headers, "X-AgentGate-Idempotency-Key": "evt-n8n-tampered"},
            content=b'{"event_id":"evt-n8n-tampered","service":"tampered"}',
        )
        assert tampered.status_code == 401
        assert tampered.json()["status"] == "rejected_signature"

        stale_headers, stale_body = _simulate_n8n_envelope(
            {"event_id": "evt-n8n-stale", "service": "checkout-api"},
            secret=secret,
            timestamp=now - 600,
        )
        stale = await client.post("/webhooks/triage", headers=stale_headers, content=stale_body)
        assert stale.status_code == 401
        assert stale.json()["status"] == "rejected_stale"


def test_n8n_signed_delivery_roundtrip_against_aws_lambda_handler(tmp_path: Path) -> None:
    secret = "n8n-lambda-secret-key"
    now = 1_700_000_050
    store = SqliteIdempotencyStore(db_path=tmp_path / "lambda-n8n.db", now_fn=lambda: now)
    ingress = WebhookIngress(
        config=IngressConfig(webhook_secret=secret, max_age_seconds=300),
        store=store,
        now_fn=lambda: now,
    )
    fn = build_lambda_handler(ingress)

    try:
        health = fn(
            {
                "version": "2.0",
                "rawPath": "/health",
                "requestContext": {"http": {"method": "GET"}},
            },
            None,
        )
        assert health["statusCode"] == 200

        headers, raw_body = _simulate_n8n_envelope(
            {"service": "auth-gateway", "p95_ms": 410},
            secret=secret,
            timestamp=now - 5,
            execution_id="exec-42",
        )
        event_base: dict[str, object] = {
            "version": "2.0",
            "rawPath": "/webhooks/triage",
            "headers": headers,
            "body": raw_body.decode("utf-8"),
            "isBase64Encoded": False,
            "requestContext": {"http": {"method": "POST"}},
        }

        first = fn(event_base, None)
        assert first["statusCode"] == 200
        assert isinstance(first["body"], str)
        assert json.loads(first["body"])["status"] == "accepted"

        second = fn(event_base, None)
        assert second["statusCode"] == 200
        assert isinstance(second["body"], str)
        assert json.loads(second["body"])["status"] == "duplicate"

        tampered = fn({**event_base, "body": '{"service":"tampered"}'}, None)
        assert tampered["statusCode"] == 401
        assert isinstance(tampered["body"], str)
        assert json.loads(tampered["body"])["status"] == "rejected_signature"

        stale_headers, stale_body = _simulate_n8n_envelope(
            {"event_id": "evt-lam-stale", "service": "auth-gateway"},
            secret=secret,
            timestamp=now - 500,
        )
        stale = fn(
            {
                **event_base,
                "headers": stale_headers,
                "body": stale_body.decode("utf-8"),
            },
            None,
        )
        assert stale["statusCode"] == 401
        assert isinstance(stale["body"], str)
        assert json.loads(stale["body"])["status"] == "rejected_stale"
    finally:
        ingress.close()
