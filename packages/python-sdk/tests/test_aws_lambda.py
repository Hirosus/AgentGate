"""Tests for AWS Lambda API Gateway v2 webhook handler."""

import base64
import json
import re
from pathlib import Path

import pytest

from agentgate.aws_lambda import build_lambda_handler, handler, reset_default_handler
from agentgate.ingress import IngressConfig, WebhookIngress
from agentgate.seams import InMemoryIdempotencyStore
from agentgate.webhook import sign_payload


def _make_ingress(now: int = 1_700_000_010) -> WebhookIngress:
    store = InMemoryIdempotencyStore(current_time=now)
    return WebhookIngress(
        config=IngressConfig(webhook_secret="lambda-secret"),
        store=store,
        now_fn=lambda: now,
    )


def test_lambda_handler_health_check_v2_and_stage_prefix() -> None:
    fn = build_lambda_handler(_make_ingress())

    root_res = fn(
        {
            "version": "2.0",
            "rawPath": "/health",
            "requestContext": {"stage": "$default", "http": {"method": "GET"}},
        },
        None,
    )
    assert root_res["statusCode"] == 200
    assert root_res["headers"] == {"content-type": "application/json"}
    assert root_res["body"] == '{"status": "ok"}'

    stage_res = fn(
        {
            "version": "2.0",
            "rawPath": "/prod/health",
            "requestContext": {"stage": "prod", "http": {"method": "GET"}},
        },
        None,
    )
    assert stage_res["statusCode"] == 200
    assert stage_res["body"] == '{"status": "ok"}'


def test_lambda_handler_accepts_signed_webhook_then_marks_duplicate() -> None:
    fn = build_lambda_handler(_make_ingress())
    raw_text = '{"incident":"INC-501"}'
    sig = sign_payload(
        "lambda-secret",
        1_700_000_005,
        raw_text.encode("utf-8"),
        idempotency_key="evt-lam-1",
    )
    headers = {
        "X-AgentGate-Idempotency-Key": "evt-lam-1",
        "X-AgentGate-Timestamp": "1700000005",
        "X-AgentGate-Signature": sig,
    }

    first = fn(
        {
            "version": "2.0",
            "rawPath": "/webhooks/triage",
            "headers": headers,
            "body": raw_text,
            "isBase64Encoded": False,
            "requestContext": {"stage": "$default", "http": {"method": "POST"}},
        },
        None,
    )
    assert first["statusCode"] == 200
    first_body = first["body"]
    assert isinstance(first_body, str)
    assert json.loads(first_body)["status"] == "accepted"

    duplicate = fn(
        {
            "version": "2.0",
            "rawPath": "/webhooks/triage",
            "headers": headers,
            "body": raw_text,
            "isBase64Encoded": False,
            "requestContext": {"stage": "$default", "http": {"method": "POST"}},
        },
        None,
    )
    assert duplicate["statusCode"] == 200
    dup_body = duplicate["body"]
    assert isinstance(dup_body, str)
    assert json.loads(dup_body)["status"] == "duplicate"

    sig_staged = sign_payload(
        "lambda-secret",
        1_700_000_005,
        raw_text.encode("utf-8"),
        idempotency_key="evt-lam-2",
    )
    staged = fn(
        {
            "version": "2.0",
            "rawPath": "/prod/webhooks/triage",
            "headers": {
                **headers,
                "X-AgentGate-Idempotency-Key": "evt-lam-2",
                "X-AgentGate-Signature": sig_staged,
            },
            "body": raw_text,
            "isBase64Encoded": False,
            "requestContext": {"stage": "prod", "http": {"method": "POST"}},
        },
        None,
    )
    assert staged["statusCode"] == 200
    staged_body = staged["body"]
    assert isinstance(staged_body, str)
    assert json.loads(staged_body)["status"] == "accepted"


def test_lambda_handler_decodes_base64_body_before_hmac_verification() -> None:
    fn = build_lambda_handler(_make_ingress())
    raw_bytes = b'{\n "alert": "db_pool" \n}'
    sig = sign_payload("lambda-secret", 1_700_000_005, raw_bytes, idempotency_key="evt-b64")
    encoded = base64.b64encode(raw_bytes).decode("ascii")

    ok = fn(
        {
            "version": "2.0",
            "rawPath": "/webhooks/triage",
            "headers": {
                "x-agentgate-idempotency-key": "evt-b64",
                "x-agentgate-timestamp": "1700000005",
                "x-agentgate-signature": sig,
            },
            "body": encoded,
            "isBase64Encoded": True,
            "requestContext": {"http": {"method": "POST"}},
        },
        None,
    )
    assert ok["statusCode"] == 200
    ok_body = ok["body"]
    assert isinstance(ok_body, str)
    assert json.loads(ok_body)["status"] == "accepted"

    bad_b64 = fn(
        {
            "version": "2.0",
            "rawPath": "/webhooks/triage",
            "headers": {
                "x-agentgate-idempotency-key": "evt-b64-bad",
                "x-agentgate-timestamp": "1700000005",
                "x-agentgate-signature": sig,
            },
            "body": "not-valid-base64!!!",
            "isBase64Encoded": True,
            "requestContext": {"http": {"method": "POST"}},
        },
        None,
    )
    assert bad_b64["statusCode"] == 400
    bad_body = bad_b64["body"]
    assert isinstance(bad_body, str)
    assert "detail" in json.loads(bad_body)


def test_lambda_handler_rejects_bad_signature_and_unknown_routes() -> None:
    fn = build_lambda_handler(_make_ingress())

    bad_sig = fn(
        {
            "version": "2.0",
            "rawPath": "/webhooks/triage",
            "headers": {
                "X-AgentGate-Idempotency-Key": "evt-bad-sig",
                "X-AgentGate-Timestamp": "1700000005",
                "X-AgentGate-Signature": "v1=deadbeef",
            },
            "body": "{}",
            "requestContext": {"http": {"method": "POST"}},
        },
        None,
    )
    assert bad_sig["statusCode"] == 401
    bad_sig_body = bad_sig["body"]
    assert isinstance(bad_sig_body, str)
    assert json.loads(bad_sig_body)["status"] == "rejected_signature"

    unknown_path = fn(
        {
            "version": "2.0",
            "rawPath": "/unknown",
            "requestContext": {"http": {"method": "GET"}},
        },
        None,
    )
    assert unknown_path["statusCode"] == 404
    unknown_body = unknown_path["body"]
    assert isinstance(unknown_body, str)
    assert "detail" in json.loads(unknown_body)

    wrong_method = fn(
        {
            "version": "2.0",
            "rawPath": "/webhooks/triage",
            "requestContext": {"http": {"method": "DELETE"}},
        },
        None,
    )
    assert wrong_method["statusCode"] == 405
    wrong_body = wrong_method["body"]
    assert isinstance(wrong_body, str)
    assert "detail" in json.loads(wrong_body)

    wrong_health_method = fn(
        {
            "version": "2.0",
            "rawPath": "/health",
            "requestContext": {"http": {"method": "POST"}},
        },
        None,
    )
    assert wrong_health_method["statusCode"] == 405


def test_default_module_handler_initializes_from_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reset_default_handler()
    monkeypatch.setenv("AGENTGATE_WEBHOOK_SECRET", "env-lambda-secret")
    monkeypatch.setenv("AGENTGATE_STORE_BACKEND", "memory")
    try:
        res = handler(
            {
                "version": "2.0",
                "rawPath": "/health",
                "requestContext": {"http": {"method": "GET"}},
            },
            None,
        )
        assert res["statusCode"] == 200
        assert res["body"] == '{"status": "ok"}'
    finally:
        reset_default_handler()


def test_sam_template_contract_matches_linux_lambda_bundle() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    template_path = repo_root / "infra" / "template.yaml"
    text = template_path.read_text(encoding="utf-8")

    assert "Runtime: python3.11" in text
    assert re.search(r"Architectures:\s*\n\s*-\s*x86_64", text) is not None
    assert "CodeUri: build/lambda/" in text
    assert "Handler: agentgate.aws_lambda.handler" in text
    assert "MinLength: 32" in text
    assert "AGENTGATE_STORE_BACKEND: dynamodb" in text
    assert "IDEMPOTENCY_TABLE: !Ref IdempotencyTable" in text
    assert "REPORTS_BUCKET" not in text
    assert "PutItem" in text
    assert "DeleteItem" in text
    assert "Path: /health" in text
    assert "Path: /webhooks/triage" in text


def test_lambda_handler_handles_v1_path_bytes_base64_multivalue_headers_and_triage() -> None:
    now = 1_700_000_010
    store = InMemoryIdempotencyStore(current_time=now)
    ingress = WebhookIngress(
        config=IngressConfig(webhook_secret="lambda-secret", triage_mode="deterministic"),
        store=store,
        now_fn=lambda: now,
    )
    fn = build_lambda_handler(ingress)

    # REST API v1 event (`path` instead of `rawPath`) must not strip `/prod` from path.
    v1_not_found = fn(
        {
            "httpMethod": "GET",
            "path": "/prod/health",
            "requestContext": {"stage": "prod"},
        },
        None,
    )
    assert v1_not_found["statusCode"] == 404

    raw_bytes = b'{"service":"checkout-api","p95_ms":820,"msg":"SELECT FOR UPDATE"}'
    sig = sign_payload("lambda-secret", now - 2, raw_bytes, idempotency_key="evt-b64-bytes")
    ok_bytes = fn(
        {
            "httpMethod": "POST",
            "path": "/webhooks/triage",
            "headers": {
                "X-AgentGate-Idempotency-Key": "evt-b64-bytes",
                "X-AgentGate-Timestamp": str(now - 2),
                "X-AgentGate-Signature": sig,
            },
            "body": base64.b64encode(raw_bytes),
            "isBase64Encoded": True,
        },
        None,
    )
    assert ok_bytes["statusCode"] == 200
    assert isinstance(ok_bytes["body"], str)
    parsed = json.loads(ok_bytes["body"])
    assert parsed["status"] == "accepted"
    assert parsed["triage"]["recommended_runbook"] == "rb-latency-pool"

    dup_mv = fn(
        {
            "httpMethod": "POST",
            "path": "/webhooks/triage",
            "multiValueHeaders": {
                "X-AgentGate-Idempotency-Key": ["evt-mv-1"],
                "X-AgentGate-Timestamp": [str(now - 2)],
                "X-AgentGate-Signature": [sig, sig],
            },
            "body": "{}",
            "isBase64Encoded": False,
        },
        None,
    )
    assert dup_mv["statusCode"] == 400
