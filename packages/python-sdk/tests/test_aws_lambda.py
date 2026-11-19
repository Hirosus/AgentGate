"""Tests for AWS Lambda API Gateway v2 webhook handler."""

import base64
import json

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
    sig = sign_payload("lambda-secret", 1_700_000_005, raw_text.encode("utf-8"))
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

    staged = fn(
        {
            "version": "2.0",
            "rawPath": "/prod/webhooks/triage",
            "headers": {
                **headers,
                "X-AgentGate-Idempotency-Key": "evt-lam-2",
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
    sig = sign_payload("lambda-secret", 1_700_000_005, raw_bytes)
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
    assert wrong_method["statusCode"] == 404
    wrong_body = wrong_method["body"]
    assert isinstance(wrong_body, str)
    assert "detail" in json.loads(wrong_body)


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
