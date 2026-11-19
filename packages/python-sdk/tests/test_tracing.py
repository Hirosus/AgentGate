"""Tests for OpenTelemetry-shaped JSONL, Langfuse, and Composite TraceSink adapters."""

import base64
import json
from pathlib import Path

import httpx

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
