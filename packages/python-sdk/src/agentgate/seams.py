"""Explicit Protocol seams and in-memory adapters for fast, isolated testing."""

import threading
import time
from collections.abc import Callable
from typing import Protocol

from agentgate.types import AgentOutput, EvalScenario, TraceSpan


class IdempotencyStore(Protocol):
    """Atomic key reservation store rejecting duplicate webhook deliveries."""

    def claim(self, key: str, ttl_seconds: int) -> bool:
        """Atomically claim `key` for `ttl_seconds`; return False if already claimed."""
        ...

    def release(self, key: str) -> None:
        """Release a previously claimed `key` so a failed delivery can be retried."""
        ...


class ToolRunner(Protocol):
    """Executes one triage scenario either with or without MCP tool access."""

    async def run(self, scenario: EvalScenario) -> AgentOutput:
        """Return structured triage output for `scenario`."""
        ...


class EvalJudge(Protocol):
    """Deterministic or model-based scorer judging an AgentOutput against ground truth."""

    def score(self, scenario: EvalScenario, output: AgentOutput) -> bool:
        """Return True iff `output` satisfies scenario correctness and safety criteria."""
        ...


class TraceSink(Protocol):
    """Receives execution trace spans for observability backends (local JSON / Langfuse)."""

    def emit(self, span: TraceSpan) -> None:
        """Record a single scenario execution span."""
        ...


class InMemoryIdempotencyStore:
    """Thread-safe in-memory IdempotencyStore adapter with live or deterministic clocks."""

    def __init__(
        self,
        current_time: float | None = None,
        now_fn: Callable[[], float] | None = None,
    ) -> None:
        if current_time is not None and now_fn is not None:
            raise ValueError("Specify at most one of current_time or now_fn.")
        self._lock = threading.Lock()
        self._manual_now: float | None = float(current_time) if current_time is not None else None
        self._now_fn: Callable[[], float] | None = (
            now_fn if now_fn is not None else (None if current_time is not None else time.time)
        )
        self._time_offset: float = 0.0
        self._claims: dict[str, float] = {}

    def _current_now_unlocked(self) -> float:
        if self._manual_now is not None:
            return self._manual_now
        assert self._now_fn is not None
        return float(self._now_fn()) + self._time_offset

    def advance_time(self, seconds: float) -> None:
        """Advance logical time for deterministic TTL expiration tests."""
        with self._lock:
            if self._manual_now is not None:
                self._manual_now += seconds
            else:
                self._time_offset += seconds

    def claim(self, key: str, ttl_seconds: int) -> bool:
        """Claim `key` unless an unexpired claim already exists, pruning expired entries."""
        if not key:
            raise ValueError("idempotency key must be a non-empty string.")
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be a positive integer.")

        with self._lock:
            now = self._current_now_unlocked()
            expired_keys = [k for k, exp in self._claims.items() if exp <= now]
            for expired_key in expired_keys:
                del self._claims[expired_key]

            if key in self._claims:
                return False
            self._claims[key] = now + ttl_seconds
            return True

    def release(self, key: str) -> None:
        """Release a previously claimed `key` so a failed downstream run can retry."""
        if not key:
            raise ValueError("idempotency key must be a non-empty string.")
        with self._lock:
            self._claims.pop(key, None)


class InMemoryTraceSink:
    """In-memory TraceSink adapter capturing spans for assertions and JSON export."""

    def __init__(self) -> None:
        self.spans: list[TraceSpan] = []

    def emit(self, span: TraceSpan) -> None:
        """Append `span` to the local capture list."""
        self.spans.append(span)
