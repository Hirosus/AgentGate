"""OpenTelemetry-shaped JSONL and optional Langfuse TraceSink adapters."""

import json
import threading
import time
import uuid
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from pathlib import Path
from types import TracebackType

import httpx
from pydantic import JsonValue

from agentgate.seams import TraceSink
from agentgate.types import TraceSpan


class JsonlOtelTraceSink:
    """Writes TraceSpan records as OpenTelemetry-shaped JSON Lines."""

    def __init__(
        self,
        output_path: str | Path,
        *,
        service_name: str = "agentgate-eval",
        trace_id: str | None = None,
        clock_ns_fn: Callable[[], int] | None = None,
    ) -> None:
        self._output_path = Path(output_path)
        self._output_path.parent.mkdir(parents=True, exist_ok=True)
        self._service_name = service_name
        self._trace_id = trace_id if trace_id is not None else uuid.uuid4().hex
        self._clock_ns_fn: Callable[[], int] = (
            clock_ns_fn if clock_ns_fn is not None else time.time_ns
        )
        self._lock = threading.Lock()
        self._spans_written = 0

    @property
    def spans_written(self) -> int:
        """Return total number of OTel spans appended by this sink instance."""
        return self._spans_written

    def emit(self, span: TraceSpan) -> None:
        """Append one OpenTelemetry-shaped JSON line for `span`."""
        start_ns = self._clock_ns_fn()
        end_ns = start_ns + int(span.latency_ms * 1_000_000)
        record: dict[str, JsonValue] = {
            "traceId": self._trace_id,
            "spanId": uuid.uuid4().hex[:16],
            "name": f"agentgate.eval.{span.mode}",
            "serviceName": self._service_name,
            "startTimeUnixNano": start_ns,
            "endTimeUnixNano": end_ns,
            "status": {"code": "OK" if span.passed else "ERROR"},
            "attributes": {
                "agentgate.scenario_id": span.scenario_id,
                "agentgate.mode": span.mode,
                "agentgate.passed": span.passed,
                "agentgate.latency_ms": span.latency_ms,
                "agentgate.tool_calls": span.tool_calls,
                "agentgate.total_tokens": span.total_tokens,
            },
        }
        line = json.dumps(record, separators=(",", ":")) + "\n"
        with self._lock:
            with self._output_path.open("a", encoding="utf-8") as handle:
                handle.write(line)
            self._spans_written += 1


class LangfuseTraceSink:
    """Optional Langfuse TraceSink exporting batched span-create events over HTTP."""

    def __init__(
        self,
        public_key: str,
        secret_key: str,
        host: str = "https://cloud.langfuse.com",
        *,
        transport: httpx.BaseTransport | None = None,
        timeout_seconds: float = 10.0,
    ) -> None:
        if not public_key or not secret_key:
            raise ValueError("Langfuse public_key and secret_key must be non-empty.")
        self._client = httpx.Client(
            base_url=host.rstrip("/"),
            auth=(public_key, secret_key),
            timeout=timeout_seconds,
            transport=transport,
        )
        self._lock = threading.Lock()
        self._buffer: list[dict[str, JsonValue]] = []

    def __enter__(self) -> "LangfuseTraceSink":
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        try:
            self.flush()
        finally:
            self.close()

    def close(self) -> None:
        """Close the underlying synchronous HTTP client cleanly."""
        self._client.close()

    def emit(self, span: TraceSpan) -> None:
        """Buffer a Langfuse `span-create` ingestion event for `span`."""
        event: dict[str, JsonValue] = {
            "id": uuid.uuid4().hex,
            "type": "span-create",
            "timestamp": datetime.now(UTC).isoformat(),
            "body": {
                "id": uuid.uuid4().hex,
                "name": f"agentgate.eval.{span.mode}",
                "level": "DEFAULT" if span.passed else "ERROR",
                "metadata": {
                    "scenario_id": span.scenario_id,
                    "mode": span.mode,
                    "passed": span.passed,
                    "latency_ms": span.latency_ms,
                    "tool_calls": span.tool_calls,
                    "total_tokens": span.total_tokens,
                },
            },
        }
        with self._lock:
            self._buffer.append(event)

    def flush(self) -> int:
        """POST buffered Langfuse events to `/api/public/ingestion` and return flushed count."""
        with self._lock:
            if not self._buffer:
                return 0
            batch = list(self._buffer)
            response = self._client.post("/api/public/ingestion", json={"batch": batch})
            response.raise_for_status()
            self._buffer.clear()
            return len(batch)


class CompositeTraceSink:
    """Fans out TraceSpan emissions across multiple TraceSink adapters."""

    def __init__(self, sinks: Sequence[TraceSink]) -> None:
        self._sinks = tuple(sinks)

    def emit(self, span: TraceSpan) -> None:
        """Forward `span` to every configured downstream TraceSink."""
        for sink in self._sinks:
            sink.emit(span)
