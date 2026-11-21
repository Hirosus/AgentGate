"""Tests for 20-scenario benchmark suite loading and CLI CI quality gate."""

from pathlib import Path

import pytest

from agentgate.cli import _build_parser, load_dotenv_file, load_scenarios, main, run_benchmark
from agentgate.types import EvalSuiteReport

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCENARIOS_PATH = _REPO_ROOT / "benchmarks" / "scenarios.json"

_EXPECTED_RUNBOOKS = {
    "rb-latency-pool",
    "rb-hmac-rotation",
    "rb-webhook-retry",
    "rb-net-vlan",
    "rb-tls-renewal",
    "rb-cache-eviction",
    "rb-dns-resolver",
    "rb-lambda-limits",
}


def test_benchmark_scenarios_file_has_20_valid_diverse_cases() -> None:
    scenarios = load_scenarios(_SCENARIOS_PATH)
    assert len(scenarios) == 20
    assert [s.scenario_id for s in scenarios] == [f"inc-{i:03d}" for i in range(1, 21)]
    assert sum(1 for s in scenarios if s.is_adversarial_injection) >= 5
    present_runbooks = {s.expected_runbook for s in scenarios if s.expected_runbook is not None}
    assert present_runbooks == _EXPECTED_RUNBOOKS


def test_cli_main_passes_20_case_mcp_gate_and_writes_report_and_traces(tmp_path: Path) -> None:
    out_report = tmp_path / "reports" / "latest-report.json"
    out_traces = tmp_path / "traces" / "otel.jsonl"

    exit_code = main(
        [
            "--scenarios",
            str(_SCENARIOS_PATH),
            "--output",
            str(out_report),
            "--traces",
            str(out_traces),
            "--mode",
            "mcp",
            "--min-tool-pass-rate",
            "0.95",
            "--min-delta",
            "0.50",
        ]
    )

    assert exit_code == 0
    assert out_report.exists()
    assert out_traces.exists()

    report = EvalSuiteReport.model_validate_json(out_report.read_text(encoding="utf-8"))
    assert report.total_cases == 20
    assert report.tool_pass_rate == 1.0
    assert report.baseline_pass_rate < 0.5
    assert report.schema_valid_rate == 1.0
    assert report.injection_block_rate == 1.0
    assert report.baseline_schema_valid_rate == 1.0
    assert report.baseline_injection_block_rate == 1.0
    assert report.p95_baseline_latency_ms >= 0.0
    assert report.baseline_total_tokens == 0
    assert report.p95_tool_net_latency_ms is not None
    assert report.results[0].tool_severity == "high"
    assert report.results[0].tool_runbook == "rb-latency-pool"
    assert report.results[0].tool_calls >= 1
    assert report.passed_ci_gate is True

    trace_lines = out_traces.read_text(encoding="utf-8").splitlines()
    assert len(trace_lines) == 40


def test_cli_main_returns_nonzero_when_ci_gate_fails(tmp_path: Path) -> None:
    out_report = tmp_path / "failed-report.json"
    out_traces = tmp_path / "failed-traces.jsonl"

    exit_code = main(
        [
            "--scenarios",
            str(_SCENARIOS_PATH),
            "--output",
            str(out_report),
            "--traces",
            str(out_traces),
            "--mode",
            "mcp",
            "--max-p95-ms",
            "0.0001",
        ]
    )

    assert exit_code == 1
    report = EvalSuiteReport.model_validate_json(out_report.read_text(encoding="utf-8"))
    assert report.passed_ci_gate is False
    assert any("p95_latency_ms" in failure for failure in report.gate_failures)


def test_load_dotenv_file_parses_values_and_preserves_os_env_precedence(tmp_path: Path) -> None:
    env_path = tmp_path / ".env"
    env_path.write_text(
        "# Comment line\n"
        "\n"
        "export GEMINI_MODEL=gemini-3.1-flash-lite # inline comment\n"
        'GEMINI_API_KEY="quoted#secret" # trailing comment\n'
        "LANGFUSE_HOST=https://langfuse.example#anchor\n",
        encoding="utf-8",
    )

    parsed = load_dotenv_file(env_path)
    assert parsed == {
        "GEMINI_MODEL": "gemini-3.1-flash-lite",
        "GEMINI_API_KEY": "quoted#secret",
        "LANGFUSE_HOST": "https://langfuse.example#anchor",
    }


async def test_cli_validates_before_unlinking_traces_and_writes_report_before_langfuse_flush(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    traces = tmp_path / "existing-traces.jsonl"
    traces.write_text("keep-me\n", encoding="utf-8")
    out_report = tmp_path / "out-report.json"

    with pytest.raises(ValueError, match="GEMINI_API_KEY"):
        await run_benchmark(
            scenarios_path=_SCENARIOS_PATH,
            output_path=out_report,
            traces_path=traces,
            mode="gemini",
            env={},
        )
    assert traces.read_text(encoding="utf-8") == "keep-me\n"

    with pytest.raises(FileNotFoundError):
        await run_benchmark(
            scenarios_path=_SCENARIOS_PATH,
            output_path=out_report,
            traces_path=traces,
            mode="mcp",
            mcp_server_path=tmp_path / "missing-server.js",
            env={},
        )
    assert traces.read_text(encoding="utf-8") == "keep-me\n"

    # Even if Langfuse flush fails on ExitStack exit, report JSON is already persisted.
    import agentgate.cli as cli_mod

    class _FailingLangfuseSink:
        def __init__(self, **kwargs: object) -> None:
            del kwargs

        def __enter__(self) -> "_FailingLangfuseSink":
            return self

        def __exit__(self, *args: object) -> None:
            raise RuntimeError("langfuse flush failed")

        def emit(self, span: object) -> None:
            del span

    monkeypatch.setattr(cli_mod, "LangfuseTraceSink", _FailingLangfuseSink)
    with pytest.raises(RuntimeError, match="langfuse flush failed"):
        await run_benchmark(
            scenarios_path=_SCENARIOS_PATH,
            output_path=out_report,
            traces_path=traces,
            mode="mcp",
            env={"LANGFUSE_PUBLIC_KEY": "pk", "LANGFUSE_SECRET_KEY": "sk"},
        )
    assert out_report.exists()
    persisted = EvalSuiteReport.model_validate_json(out_report.read_text(encoding="utf-8"))
    assert persisted.total_cases == 20

    args = _build_parser().parse_args(["--mode", "gemini"])
    assert args.max_p95_ms is None
