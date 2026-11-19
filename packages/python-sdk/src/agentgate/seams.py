"""Explicit Protocol seams and in-memory adapters for fast, isolated testing."""

from typing import Protocol

from agentgate.types import AgentOutput, EvalScenario, TraceSpan


class IdempotencyStore(Protocol):
    """Atomic key reservation store rejecting duplicate webhook deliveries."""

    def claim(self, key: str, ttl_seconds: int) -> bool:
        """Atomically claim `key` for `ttl_seconds`; return False if already claimed."""
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
    """In-memory IdempotencyStore adapter with deterministic clock support."""

    def __init__(self, current_time: int = 0) -> None:
        self._now = current_time
        self._claims: dict[str, int] = {}

    def advance_time(self, seconds: int) -> None:
        """Advance logical time for deterministic TTL expiration tests."""
        self._now += seconds

    def claim(self, key: str, ttl_seconds: int) -> bool:
        """Claim `key` unless an unexpired claim already exists."""
        expires_at = self._claims.get(key)
        if expires_at is not None and expires_at > self._now:
            return False
        self._claims[key] = self._now + ttl_seconds
        return True


class InMemoryTraceSink:
    """In-memory TraceSink adapter capturing spans for assertions and JSON export."""

    def __init__(self) -> None:
        self.spans: list[TraceSpan] = []

    def emit(self, span: TraceSpan) -> None:
        """Append `span` to the local capture list."""
        self.spans.append(span)
