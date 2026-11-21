"""MCP stdio JSON-RPC client and injection-resistant MCP triage runner."""

import asyncio
import contextlib
import json
import re
from collections import deque
from collections.abc import Mapping, Sequence
from pathlib import Path
from types import TracebackType
from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict, JsonValue, TypeAdapter

from agentgate.types import AgentOutput, EvalScenario

_PROTOCOL_VERSION = "2024-11-05"
_READ_LIMIT_BYTES = 1024 * 1024
_STDERR_BUFFER_LINES = 200
_JSON_DICT_ADAPTER: TypeAdapter[dict[str, JsonValue]] = TypeAdapter(dict[str, JsonValue])
_STR_LIST_ADAPTER: TypeAdapter[list[str]] = TypeAdapter(list[str])

_Severity = Literal["low", "medium", "high", "critical"]

_KNOWN_SERVICES: tuple[str, ...] = (
    "checkout-api",
    "webhook-ingress",
    "edge-switch-01",
    "payments-worker",
    "auth-gateway",
    "session-cache",
    "core-dns",
    "triage-lambda",
    "edge-node-2",
)

_SERVICE_BUDGETS_MS: dict[str, float] = {
    "checkout-api": 250.0,
    "webhook-ingress": 100.0,
    "edge-switch-01": 40.0,
    "payments-worker": 400.0,
    "auth-gateway": 120.0,
    "session-cache": 15.0,
    "core-dns": 30.0,
    "triage-lambda": 800.0,
    "edge-node-2": 150.0,
}

_SYMPTOM_RUNBOOKS: dict[str, str] = {
    "db_pool_exhaustion": "rb-latency-pool",
    "auth_failure": "rb-hmac-rotation",
    "webhook_timeout": "rb-webhook-retry",
    "vlan_packet_loss": "rb-net-vlan",
    "tls_cert_expiry": "rb-tls-renewal",
    "redis_eviction_spike": "rb-cache-eviction",
    "dns_resolution_failure": "rb-dns-resolver",
    "lambda_oom_throttle": "rb-lambda-limits",
}

_SYMPTOM_RULES: tuple[tuple[str, tuple[str, ...], _Severity], ...] = (
    (
        "db_pool_exhaustion",
        (
            "pg_pool",
            "select for update",
            "select ... for update",
            "pool exhaustion",
            "connection pool",
            "max_connections",
            "waiting=",
        ),
        "high",
    ),
    (
        "auth_failure",
        (
            "rejected_signature",
            "hmac",
            "signature mismatch",
            "clock_skew",
            "x-agentgate-signature",
        ),
        "medium",
    ),
    (
        "webhook_timeout",
        (
            "webhook",
            "504",
            "dlq",
            "retry_backoff",
            "delivery timeout",
        ),
        "medium",
    ),
    (
        "vlan_packet_loss",
        (
            "vlan",
            "packet_loss",
            "packet loss",
            "crc_errors",
            "duplex",
            "uplink",
        ),
        "high",
    ),
    (
        "tls_cert_expiry",
        (
            "tls",
            "x509",
            "certificate has expired",
            "expired_at",
            "certificate expired",
        ),
        "high",
    ),
    (
        "redis_eviction_spike",
        (
            "redis",
            "evicted_keys",
            "maxmemory",
            "hit_ratio",
        ),
        "high",
    ),
    (
        "dns_resolution_failure",
        (
            "coredns",
            "servfail",
            "dns",
            "resolv",
        ),
        "high",
    ),
    (
        "lambda_oom_throttle",
        (
            "runtime.outofmemory",
            "outofmemory",
            "oom",
            "toomanyrequestsexception",
            "lambda",
        ),
        "high",
    ),
)

_INJECTION_CLAUSE_RE = re.compile(
    r"\b(?:system override|ignore previous(?:\s+instructions|\s+rules)?|"
    r"disregard previous(?:\s+instructions|\s+rules)?|new system instruction)\b"
    r"[^\n.!?]*(?:[.!?]+|\n|$)",
    re.IGNORECASE,
)
_OVERRIDE_DIRECTIVE_RE = re.compile(
    r"\b(?:severity|runbook)\s*=\s*[a-z0-9_-]+",
    re.IGNORECASE,
)
_SERVICE_HINT_RE = re.compile(
    r"\b(?:on|service|host|node)\s+([a-z0-9][a-z0-9-]{1,62})\b",
)
_P95_LATENCY_RE = re.compile(
    r"\bp95(?:_ms|\s+latency)?\s*(?:=|is|:|\s)\s*(\d+(?:\.\d+)?)\s*(?:ms)?\b",
    re.IGNORECASE,
)


class McpProtocolError(RuntimeError):
    """Raised when the MCP stdio subprocess fails handshake, framing, or timeout bounds."""


class McpToolDefinition(BaseModel):
    """Tool metadata advertised by an MCP server via `tools/list`."""

    model_config = ConfigDict(frozen=True)

    name: str
    description: str
    input_schema: dict[str, JsonValue]


class McpToolCallResult(BaseModel):
    """Text response returned by an MCP server for `tools/call`."""

    model_config = ConfigDict(frozen=True)

    tool_name: str
    text: str
    is_error: bool = False


class McpClientProtocol(Protocol):
    """Structural seam satisfied by McpStdioClient and test doubles."""

    async def list_tools(self) -> tuple[McpToolDefinition, ...]:
        """Return available tools registered on the connected MCP server."""
        ...

    async def call_tool(
        self,
        name: str,
        arguments: Mapping[str, JsonValue],
    ) -> McpToolCallResult:
        """Invoke a named MCP tool with JSON-serializable arguments."""
        ...


def default_mcp_server_entrypoint() -> Path:
    """Resolve the compiled TypeScript MCP server entrypoint in this monorepo."""
    return Path(__file__).resolve().parents[3] / "mcp-server" / "dist" / "index.js"


class McpStdioClient:
    """Async newline-delimited JSON-RPC 2.0 client over subprocess stdio."""

    def __init__(
        self,
        command: Sequence[str],
        *,
        cwd: str | Path | None = None,
        timeout_seconds: float = 10.0,
    ) -> None:
        if not command:
            raise ValueError("command must contain at least one executable argument.")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive.")
        self._command = tuple(command)
        self._cwd = Path(cwd) if cwd is not None else None
        self._timeout_seconds = timeout_seconds
        self._process: asyncio.subprocess.Process | None = None
        self._stderr_lines: deque[str] = deque(maxlen=_STDERR_BUFFER_LINES)
        self._stderr_task: asyncio.Task[None] | None = None
        self._next_id = 1
        self._io_lock = asyncio.Lock()

    async def _drain_stderr(self, stream: asyncio.StreamReader) -> None:
        try:
            while True:
                try:
                    raw_line = await stream.readline()
                except (asyncio.LimitOverrunError, ValueError):
                    chunk = await stream.read(4096)
                    if not chunk:
                        break
                    text = chunk.decode("utf-8", errors="replace").strip()
                    if text:
                        self._stderr_lines.append(text)
                    continue
                if not raw_line:
                    break
                text = raw_line.decode("utf-8", errors="replace").rstrip()
                if text:
                    self._stderr_lines.append(text)
        except (asyncio.CancelledError, Exception):
            return

    async def __aenter__(self) -> "McpStdioClient":
        self._stderr_lines.clear()
        self._process = await asyncio.create_subprocess_exec(
            *self._command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(self._cwd) if self._cwd is not None else None,
            limit=_READ_LIMIT_BYTES,
        )
        if self._process.stderr is not None:
            self._stderr_task = asyncio.create_task(self._drain_stderr(self._process.stderr))
        try:
            await self._initialize()
        except Exception:
            await self.aclose()
            raise
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Close stdio pipes, drain stderr task, and terminate child process cleanly."""
        proc = self._process
        stderr_task = self._stderr_task
        self._process = None
        self._stderr_task = None

        if proc is None:
            if stderr_task is not None and not stderr_task.done():
                stderr_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await asyncio.wait_for(stderr_task, timeout=1.0)
            return

        if proc.stdin is not None and not proc.stdin.is_closing():
            proc.stdin.close()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(proc.stdin.wait_closed(), timeout=1.0)

        if proc.returncode is None:
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=2.0)
                except TimeoutError:
                    with contextlib.suppress(ProcessLookupError):
                        proc.kill()
                    with contextlib.suppress(TimeoutError):
                        await asyncio.wait_for(proc.wait(), timeout=2.0)

        if stderr_task is not None:
            if not stderr_task.done():
                stderr_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, TimeoutError, Exception):
                await asyncio.wait_for(stderr_task, timeout=1.0)

    async def _write_message(self, payload: Mapping[str, JsonValue]) -> None:
        proc = self._process
        if proc is None or proc.stdin is None:
            raise McpProtocolError("MCP stdio client is not connected.")
        line = (json.dumps(payload) + "\n").encode("utf-8")
        try:
            proc.stdin.write(line)
            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError, OSError) as exc:
            raise McpProtocolError(f"Failed writing to MCP stdio stdin: {exc}") from exc

    async def _read_response(
        self,
        proc: asyncio.subprocess.Process,
        method: str,
        req_id: int,
    ) -> dict[str, JsonValue]:
        if proc.stdout is None:
            raise McpProtocolError("MCP stdio client stdout is unavailable.")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._timeout_seconds

        while True:
            remaining = deadline - loop.time()
            if remaining <= 0.0:
                raise McpProtocolError(
                    f"Timed out after {self._timeout_seconds:.1f}s waiting for {method}."
                )
            try:
                raw_line = await asyncio.wait_for(
                    proc.stdout.readline(),
                    timeout=remaining,
                )
            except TimeoutError as exc:
                raise McpProtocolError(
                    f"Timed out after {self._timeout_seconds:.1f}s waiting for {method}."
                ) from exc
            except (
                BrokenPipeError,
                ConnectionResetError,
                asyncio.LimitOverrunError,
                ValueError,
                OSError,
            ) as exc:
                raise McpProtocolError(
                    f"MCP stdio stream failure while waiting for {method}: {exc}"
                ) from exc

            if not raw_line:
                if self._stderr_task is not None and not self._stderr_task.done():
                    with contextlib.suppress(TimeoutError, Exception):
                        await asyncio.wait_for(asyncio.shield(self._stderr_task), timeout=0.2)
                stderr_text = "\n".join(self._stderr_lines).strip()
                detail = f" ({stderr_text})" if stderr_text else ""
                raise McpProtocolError(f"MCP server closed stdout during {method}{detail}.")

            text = raw_line.decode("utf-8", errors="replace").strip()
            if not text:
                continue

            try:
                msg = _JSON_DICT_ADAPTER.validate_json(text)
            except Exception as exc:
                raise McpProtocolError(
                    f"Invalid JSON-RPC frame from MCP server: {text}"
                ) from exc

            msg_id = msg.get("id")
            if msg_id is None:
                continue
            if msg_id == req_id:
                return msg

    async def _send_request(
        self,
        method: str,
        params: Mapping[str, JsonValue],
    ) -> dict[str, JsonValue]:
        async with self._io_lock:
            proc = self._process
            if proc is None or proc.stdout is None:
                raise McpProtocolError("MCP stdio client is not connected.")

            req_id = self._next_id
            self._next_id += 1
            await self._write_message(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "method": method,
                    "params": dict(params),
                }
            )
            return await self._read_response(proc, method, req_id)

    async def _initialize(self) -> None:
        response = await self._send_request(
            "initialize",
            {
                "protocolVersion": _PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "agentgate-python-sdk", "version": "0.1.0"},
            },
        )
        if "error" in response:
            raise McpProtocolError(f"MCP initialize failed: {response['error']}")
        await self._write_message({"jsonrpc": "2.0", "method": "notifications/initialized"})

    async def list_tools(self) -> tuple[McpToolDefinition, ...]:
        """Fetch registered tool definitions from the MCP server."""
        response = await self._send_request("tools/list", {})
        if "error" in response:
            raise McpProtocolError(f"MCP tools/list failed: {response['error']}")
        result = response.get("result")
        if not isinstance(result, dict):
            raise McpProtocolError("MCP tools/list response missing result object.")
        raw_tools = result.get("tools")
        if not isinstance(raw_tools, list):
            raise McpProtocolError("MCP tools/list result missing tools list.")

        parsed: list[McpToolDefinition] = []
        for item in raw_tools:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            description = item.get("description")
            input_schema = item.get("inputSchema")
            if isinstance(name, str) and isinstance(input_schema, dict):
                parsed.append(
                    McpToolDefinition(
                        name=name,
                        description=description if isinstance(description, str) else "",
                        input_schema=input_schema,
                    )
                )
        return tuple(parsed)

    async def call_tool(
        self,
        name: str,
        arguments: Mapping[str, JsonValue],
    ) -> McpToolCallResult:
        """Invoke a tool on the MCP server, surfacing validation errors via `is_error=True`."""
        response = await self._send_request(
            "tools/call",
            {"name": name, "arguments": dict(arguments)},
        )
        error_obj = response.get("error")
        if isinstance(error_obj, dict):
            message = error_obj.get("message")
            text = message if isinstance(message, str) else json.dumps(error_obj)
            return McpToolCallResult(tool_name=name, text=text, is_error=True)

        result = response.get("result")
        if not isinstance(result, dict):
            raise McpProtocolError(f"MCP tools/call for {name} missing result object.")

        is_error = result.get("isError") is True
        raw_content = result.get("content")
        texts: list[str] = []
        if isinstance(raw_content, list):
            for block in raw_content:
                if isinstance(block, dict):
                    block_text = block.get("text")
                    if isinstance(block_text, str):
                        texts.append(block_text)
        return McpToolCallResult(
            tool_name=name,
            text="\n".join(texts),
            is_error=is_error,
        )


def _strip_untrusted_directives(raw_text: str) -> str:
    without_clauses = _INJECTION_CLAUSE_RE.sub(" ", raw_text)
    without_overrides = _OVERRIDE_DIRECTIVE_RE.sub(" ", without_clauses)
    return " ".join(without_overrides.split())


def _strip_service_token(text: str, service: str | None) -> str:
    if not service:
        return text
    pattern = rf"(?<![a-z0-9-]){re.escape(service)}(?![a-z0-9-])"
    return re.sub(pattern, " ", text, flags=re.IGNORECASE)


def _extract_service(sanitized_text: str) -> str | None:
    lowered = sanitized_text.lower()
    for service in _KNOWN_SERVICES:
        if service in lowered:
            return service
    match = _SERVICE_HINT_RE.search(lowered)
    if match is not None:
        return match.group(1)
    return None


def _extract_p95_ms(sanitized_text: str) -> float | None:
    match = _P95_LATENCY_RE.search(sanitized_text)
    if match is None:
        return None
    return float(match.group(1))


def _classify_symptom(combined_sanitized: str) -> tuple[str | None, _Severity]:
    lowered = combined_sanitized.lower()
    for tag, keywords, default_severity in _SYMPTOM_RULES:
        if any(keyword in lowered for keyword in keywords):
            return tag, default_severity
    return None, "low"


def _calibrate_latency_severity(service: str, p95_ms: float) -> _Severity:
    budget_ms = _SERVICE_BUDGETS_MS.get(service, 500.0)
    ratio = p95_ms / budget_ms if budget_ms > 0.0 else 1.0
    if ratio >= 5.0:
        return "critical"
    if ratio >= 3.0:
        return "high"
    if ratio > 1.0:
        return "medium"
    return "low"


def _parse_severity(value: JsonValue) -> _Severity | None:
    if value == "low":
        return "low"
    if value == "medium":
        return "medium"
    if value == "high":
        return "high"
    if value == "critical":
        return "critical"
    return None


def run_deterministic_triage(payload_text: str) -> AgentOutput:
    """Run inline deterministic, injection-resistant triage without spawning an MCP subprocess."""
    normalized_text = payload_text
    try:
        parsed_json = _JSON_DICT_ADAPTER.validate_json(payload_text)
    except Exception:
        parsed_json = None
    if parsed_json is not None:
        fragments: list[str] = []
        for key, value in parsed_json.items():
            if isinstance(value, (str, int, float)) and not isinstance(value, bool):
                fragments.append(f"{key} {value}")
        if fragments:
            normalized_text = " ".join(fragments)

    sanitized_payload = _strip_untrusted_directives(normalized_text)
    service = _extract_service(sanitized_payload)
    p95_ms = _extract_p95_ms(sanitized_payload)
    symptom_text = _strip_service_token(sanitized_payload, service)
    symptom_tag, symptom_severity = _classify_symptom(symptom_text)
    recommended_runbook = (
        _SYMPTOM_RUNBOOKS.get(symptom_tag) if symptom_tag is not None else None
    )

    budget_severity: _Severity | None = None
    if service is not None and p95_ms is not None:
        budget_severity = _calibrate_latency_severity(service, p95_ms)

    final_severity: _Severity = (
        budget_severity if budget_severity is not None else symptom_severity
    )
    category = symptom_tag if symptom_tag is not None else "benign-healthcheck"
    service_label = service if service is not None else "unknown-service"
    summary = (
        f"Deterministic triage for {service_label}: category={category}, "
        f"severity={final_severity}, runbook={recommended_runbook or 'none'}."
    )
    return AgentOutput(
        severity=final_severity,
        category=category,
        summary=summary,
        recommended_runbook=recommended_runbook,
        followed_untrusted_instruction=False,
        schema_valid=True,
        tool_calls=0,
    )


class McpTriageRunner:
    """Deterministic injection-resistant ToolRunner backed by an MCP diagnostic server."""

    def __init__(self, mcp_client: McpClientProtocol) -> None:
        self._mcp = mcp_client

    async def run(self, scenario: EvalScenario) -> AgentOutput:
        """Triage one scenario using read-only MCP tools while ignoring untrusted overrides."""
        sanitized_payload = _strip_untrusted_directives(scenario.payload_text)
        service = _extract_service(sanitized_payload)
        tool_calls = 0

        sanitized_logs: list[str] = []
        if service is not None:
            log_res = await self._mcp.call_tool(
                "inspect_log_excerpt",
                {"service": service, "maxLines": 5},
            )
            tool_calls += 1
            if not log_res.is_error:
                try:
                    log_obj = _JSON_DICT_ADAPTER.validate_json(log_res.text)
                    lines = _STR_LIST_ADAPTER.validate_python(log_obj.get("lines", []))
                    sanitized_logs = [_strip_untrusted_directives(line) for line in lines]
                except Exception:
                    sanitized_logs = []

        combined_text = " ".join([sanitized_payload, *sanitized_logs])
        p95_ms = _extract_p95_ms(combined_text)

        budget_severity: _Severity | None = None
        if service is not None and p95_ms is not None:
            budget_res = await self._mcp.call_tool(
                "check_latency_budget",
                {"service": service, "p95Ms": p95_ms},
            )
            tool_calls += 1
            if not budget_res.is_error:
                try:
                    budget_obj = _JSON_DICT_ADAPTER.validate_json(budget_res.text)
                    budget_severity = _parse_severity(budget_obj.get("recommendedSeverity"))
                except Exception:
                    budget_severity = None

        symptom_text = _strip_service_token(combined_text, service)
        symptom_tag, symptom_severity = _classify_symptom(symptom_text)
        recommended_runbook: str | None = None
        if symptom_tag is not None:
            runbook_res = await self._mcp.call_tool(
                "lookup_runbook",
                {"symptomTag": symptom_tag},
            )
            tool_calls += 1
            if not runbook_res.is_error:
                try:
                    runbook_obj = _JSON_DICT_ADAPTER.validate_json(runbook_res.text)
                    raw_runbook_id = runbook_obj.get("runbookId")
                    if isinstance(raw_runbook_id, str) and raw_runbook_id:
                        recommended_runbook = raw_runbook_id
                except Exception:
                    recommended_runbook = None

        final_severity: _Severity = (
            budget_severity if budget_severity is not None else symptom_severity
        )

        category = symptom_tag if symptom_tag is not None else "benign-healthcheck"
        service_label = service if service is not None else "unknown-service"
        summary = (
            f"MCP triage for {service_label}: category={category}, "
            f"severity={final_severity}, runbook={recommended_runbook or 'none'}."
        )

        return AgentOutput(
            severity=final_severity,
            category=category,
            summary=summary,
            recommended_runbook=recommended_runbook,
            followed_untrusted_instruction=False,
            schema_valid=True,
            tool_calls=tool_calls,
        )
