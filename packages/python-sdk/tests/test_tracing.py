"""Tests for OpenTelemetry-shaped JSONL, Langfuse, and Composite TraceSink adapters."""

import base64
import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from agentgate.seams import InMemoryTraceSink
from agentgate.tracing import CompositeTraceSink, JsonlOtelTraceSink, LangfuseTraceSink
from agentgate.types import TraceSpan


def test_jsonl_otel_trace_sink_writes_valid_otel_spans(tmp_path: Path) -> None:
    trace_path = tmp_path / "traces" / "run.jsonl"
    sink = JsonlOtelTraceSink(
        trace_path,
        trace_id="a" * 32,
        clock_ns_fn=lambda: 1_700_000_000_000_000_000,
    )

    sink.emit(
        TraceSpan(
            scenario_id="inc-001",
            mode="tool",
            passed=True,
            latency_ms=42.5,
            tool_calls=2,
            total_tokens=310,
        )
    )
    sink.emit(
        TraceSpan(
            scenario_id="inc-002",
            mode="baseline",
            passed=False,
            latency_ms=10.0,
            tool_calls=0,
            total_tokens=80,
        )
    )

    assert sink.spans_written == 2
    lines = trace_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2

    first = json.loads(lines[0])
    second = json.loads(lines[1])

    assert first["traceId"] == "a" * 32
    assert len(first["spanId"]) == 16
    assert first["name"] == "agentgate.eval.tool"
    assert first["serviceName"] == "agentgate-eval"
    assert first["endTimeUnixNano"] == 1_700_000_000_000_000_000
    assert first["startTimeUnixNano"] == 1_700_000_000_000_000_000 - 42_500_000
    assert first["endTimeUnixNano"] > first["startTimeUnixNano"]
    assert first["status"] == {"code": "OK"}
    assert first["attributes"] == {
        "agentgate.scenario_id": "inc-001",
        "agentgate.mode": "tool",
        "agentgate.passed": True,
        "agentgate.latency_ms": 42.5,
        "agentgate.tool_calls": 2,
        "agentgate.total_tokens": 310,
    }

    assert second["name"] == "agentgate.eval.baseline"
    assert second["status"] == {"code": "ERROR"}
    assert second["attributes"]["agentgate.passed"] is False


def test_langfuse_trace_sink_batches_and_flushes_with_basic_auth() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        assert request.method == "POST"
        assert request.url.path == "/api/public/ingestion"
        expected_token = base64.b64encode(b"pk-test:sk-test").decode("ascii")
        assert request.headers["Authorization"] == f"Basic {expected_token}"
        payload = json.loads(request.content)
        assert len(payload["batch"]) == 2
        return httpx.Response(207, json={"successes": [{}, {}], "errors": []})

    with LangfuseTraceSink(
        public_key="pk-test",
        secret_key="sk-test",
        host="https://langfuse.example.test",
        transport=httpx.MockTransport(handler),
    ) as sink:
        sink.emit(
            TraceSpan(
                scenario_id="inc-001",
                mode="baseline",
                passed=False,
                latency_ms=12.0,
                tool_calls=0,
                total_tokens=90,
            )
        )
        sink.emit(
            TraceSpan(
                scenario_id="inc-001",
                mode="tool",
                passed=True,
                latency_ms=55.0,
                tool_calls=3,
                total_tokens=240,
            )
        )
        assert sink.flush() == 2
        assert sink.flush() == 0

    assert len(captured) == 1


def test_composite_trace_sink_fans_out_to_all_sinks(tmp_path: Path) -> None:
    mem = InMemoryTraceSink()
    jsonl = JsonlOtelTraceSink(tmp_path / "fanout.jsonl")
    composite = CompositeTraceSink([mem, jsonl])

    span = TraceSpan(
        scenario_id="inc-003",
        mode="tool",
        passed=True,
        latency_ms=15.0,
        tool_calls=1,
        total_tokens=100,
    )
    composite.emit(span)

    assert mem.spans == [span]
    assert jsonl.spans_written == 1


def test_langfuse_trace_sink_includes_trace_timestamps_and_handles_207_partial_errors() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        payload = json.loads(request.content)
        batch = payload["batch"]
        if calls == 1:
            assert len(batch) == 2
            for item in batch:
                body = item["body"]
                assert isinstance(body["traceId"], str) and body["traceId"]
                assert "startTime" in body and "endTime" in body
                assert body["endTime"] >= body["startTime"]
            failed_id = batch[1]["id"]
            return httpx.Response(
                207,
                json={
                    "successes": [{"id": batch[0]["id"]}],
                    "errors": [{"id": failed_id, "status": 429, "message": "rate limited"}],
                },
            )
        assert len(batch) == 1
        return httpx.Response(207, json={"successes": [{"id": batch[0]["id"]}], "errors": []})

    fixed_now = datetime(2026, 11, 21, 12, 0, 0, tzinfo=UTC)
    sink = LangfuseTraceSink(
        public_key="pk-test",
        secret_key="sk-test",
        host="https://langfuse.example.test",
        transport=httpx.MockTransport(handler),
        trace_id="trace-custom-1",
        clock_fn=lambda: fixed_now,
    )
    try:
        sink.emit(
            TraceSpan(
                scenario_id="inc-001",
                mode="baseline",
                passed=True,
                latency_ms=10.0,
                tool_calls=0,
                total_tokens=10,
            )
        )
        sink.emit(
            TraceSpan(
                scenario_id="inc-002",
                mode="tool",
                passed=True,
                latency_ms=25.0,
                tool_calls=2,
                total_tokens=50,
            )
        )
        with pytest.raises(RuntimeError, match="partially failed"):
            sink.flush()

        # Only the failed span remains in buffer and succeeds on retry flush.
        assert sink.flush() == 1
        assert sink.flush() == 0
    finally:
        sink.close()


def test_composite_trace_sink_isolates_failing_downstream_sink(tmp_path: Path) -> None:
    class _BrokenSink:
        def emit(self, span: TraceSpan) -> None:
            raise OSError("downstream telemetry offline")

    mem = InMemoryTraceSink()
    jsonl = JsonlOtelTraceSink(tmp_path / "isolated.jsonl")
    composite = CompositeTraceSink([_BrokenSink(), mem, jsonl])
    span = TraceSpan(
        scenario_id="inc-iso",
        mode="tool",
        passed=True,
        latency_ms=5.0,
        tool_calls=1,
        total_tokens=20,
    )
    composite.emit(span)
    assert mem.spans == [span]
    assert jsonl.spans_written == 1
