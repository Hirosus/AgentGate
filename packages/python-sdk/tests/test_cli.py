"""Tests for 20-scenario benchmark suite loading and CLI CI quality gate."""

from pathlib import Path

from agentgate.cli import load_scenarios, main
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
