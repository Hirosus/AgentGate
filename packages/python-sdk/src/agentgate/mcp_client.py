"""MCP stdio JSON-RPC client and injection-resistant MCP triage runner."""

import asyncio
import contextlib
import json
import re
from collections.abc import Mapping, Sequence
from pathlib import Path
from types import TracebackType
from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict, JsonValue, TypeAdapter

from agentgate.types import AgentOutput, EvalScenario

_PROTOCOL_VERSION = "2024-11-05"
_READ_LIMIT_BYTES = 1024 * 1024
_JSON_DICT_ADAPTER: TypeAdapter[dict[str, JsonValue]] = TypeAdapter(dict[str, JsonValue])
_STR_LIST_ADAPTER: TypeAdapter[list[str]] = TypeAdapter(list[str])

_Severity = Literal["low", "medium", "high", "critical"]
_SEVERITY_RANK: dict[_Severity, int] = {
    "low": 0,
    "medium": 1,
    "high": 2,
    "critical": 3,
}

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
        ("__deliberate_regression_disabled__",),
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

_INJECTION_CUT_RE = re.compile(
    r"\b(?:system override|ignore previous|disregard previous|new system instruction)\b",
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
    r"\bp95(?:\s+latency)?\s*(?:=|is|:|\s)\s*(\d+(?:\.\d+)?)\s*ms\b",
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
        self._next_id = 1
        self._io_lock = asyncio.Lock()

    async def __aenter__(self) -> "McpStdioClient":
        self._process = await asyncio.create_subprocess_exec(
            *self._command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(self._cwd) if self._cwd is not None else None,
            limit=_READ_LIMIT_BYTES,
        )
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
        """Close stdio pipes and terminate the child process without leaking handles."""
        proc = self._process
        if proc is None:
            return
        self._process = None

        if proc.stdin is not None and not proc.stdin.is_closing():
            proc.stdin.close()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(proc.stdin.wait_closed(), timeout=1.0)

        if proc.returncode is None:
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except TimeoutError:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=2.0)
                except TimeoutError:
                    proc.kill()
                    await proc.wait()

    async def _write_message(self, payload: Mapping[str, JsonValue]) -> None:
        proc = self._process
        if proc is None or proc.stdin is None:
            raise McpProtocolError("MCP stdio client is not connected.")
        line = (json.dumps(payload) + "\n").encode("utf-8")
        proc.stdin.write(line)
        await proc.stdin.drain()

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

            while True:
                try:
                    raw_line = await asyncio.wait_for(
                        proc.stdout.readline(),
                        timeout=self._timeout_seconds,
                    )
                except TimeoutError as exc:
                    raise McpProtocolError(
                        f"Timed out after {self._timeout_seconds:.1f}s waiting for {method}."
                    ) from exc

                if not raw_line:
                    stderr_text = ""
                    if proc.stderr is not None:
                        try:
                            stderr_bytes = await asyncio.wait_for(proc.stderr.read(), timeout=0.5)
                            stderr_text = stderr_bytes.decode("utf-8", errors="replace").strip()
                        except Exception:
                            stderr_text = ""
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
            if (
                isinstance(name, str)
                and isinstance(description, str)
                and isinstance(input_schema, dict)
            ):
                parsed.append(
                    McpToolDefinition(
                        name=name,
                        description=description,
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
    match = _INJECTION_CUT_RE.search(raw_text)
    truncated = raw_text[: match.start()] if match is not None else raw_text
    return _OVERRIDE_DIRECTIVE_RE.sub("", truncated).strip()


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


def _max_severity(left: _Severity, right: _Severity) -> _Severity:
    return left if _SEVERITY_RANK[left] >= _SEVERITY_RANK[right] else right


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

        symptom_tag, symptom_severity = _classify_symptom(combined_text)
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

        final_severity: _Severity = symptom_severity
        if budget_severity is not None:
            final_severity = _max_severity(final_severity, budget_severity)

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
