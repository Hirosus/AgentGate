"""CLI entrypoint for running AgentGate baseline vs. MCP-tool evaluation gates."""

import argparse
import asyncio
import os
from collections.abc import Mapping, Sequence
from contextlib import ExitStack
from pathlib import Path
from typing import Literal

from pydantic import TypeAdapter

from agentgate.evaluator import evaluate_suite
from agentgate.llm_gemini import GeminiToolRunner, RequestPacer
from agentgate.mcp_client import (
    McpStdioClient,
    McpTriageRunner,
    default_mcp_server_entrypoint,
)
from agentgate.seams import ToolRunner, TraceSink
from agentgate.tracing import CompositeTraceSink, JsonlOtelTraceSink, LangfuseTraceSink
from agentgate.types import AgentOutput, EvalScenario, EvalSuiteReport, GateThresholds

_SCENARIO_LIST_ADAPTER: TypeAdapter[list[EvalScenario]] = TypeAdapter(list[EvalScenario])


class HeuristicBaselineRunner:
    """No-tool baseline runner using simple keyword heuristics without MCP access."""

    async def run(self, scenario: EvalScenario) -> AgentOutput:
        """Return a baseline classification with no MCP tool calls or runbooks."""
        lowered = scenario.payload_text.lower()
        is_benign_probe = "healthcheck" in lowered or "heartbeat" in lowered
        return AgentOutput(
            severity="low" if is_benign_probe else "medium",
            category="baseline-heuristic",
            summary="Heuristic classification without MCP telemetry or runbook lookup.",
            recommended_runbook=None,
            followed_untrusted_instruction=False,
            schema_valid=True,
            tool_calls=0,
        )


def load_scenarios(path: str | Path) -> tuple[EvalScenario, ...]:
    """Load and validate an EvalScenario JSON array from disk."""
    raw = Path(path).read_text(encoding="utf-8")
    return tuple(_SCENARIO_LIST_ADAPTER.validate_json(raw))


def load_dotenv_file(path: Path) -> dict[str, str]:
    """Parse key=value pairs from a dotenv file, stripping matching surrounding quotes."""
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        cleaned_key = key.strip()
        cleaned_val = value.strip()
        if (
            len(cleaned_val) >= 2
            and cleaned_val[0] == cleaned_val[-1]
            and cleaned_val[0] in ("'", '"')
        ):
            cleaned_val = cleaned_val[1:-1]
        if cleaned_key:
            values[cleaned_key] = cleaned_val
    return values


async def run_benchmark(
    *,
    scenarios_path: Path,
    output_path: Path,
    traces_path: Path,
    mode: Literal["mcp", "gemini"] = "mcp",
    thresholds: GateThresholds | None = None,
    mcp_server_path: Path | None = None,
    env: Mapping[str, str] | None = None,
    env_file: Path | None = None,
    gemini_model: str | None = None,
    gemini_interval_seconds: float = 4.5,
) -> EvalSuiteReport:
    """Execute paired baseline vs. tool evaluation, emit traces/report, and return the report."""
    scenarios = load_scenarios(scenarios_path)
    base_env: Mapping[str, str] = os.environ if env is None else env
    dotenv_values = load_dotenv_file(env_file) if env_file is not None else {}
    resolved_env: dict[str, str] = {**dotenv_values, **base_env}
    server_js = (
        mcp_server_path if mcp_server_path is not None else default_mcp_server_entrypoint()
    )

    if traces_path.exists():
        traces_path.unlink()

    with ExitStack() as stack:
        otel_sink = JsonlOtelTraceSink(traces_path)
        sinks: list[TraceSink] = [otel_sink]

        lf_public = resolved_env.get("LANGFUSE_PUBLIC_KEY", "").strip()
        lf_secret = resolved_env.get("LANGFUSE_SECRET_KEY", "").strip()
        if lf_public and lf_secret:
            lf_host = resolved_env.get("LANGFUSE_HOST", "").strip() or "https://cloud.langfuse.com"
            langfuse_sink = stack.enter_context(
                LangfuseTraceSink(
                    public_key=lf_public,
                    secret_key=lf_secret,
                    host=lf_host,
                )
            )
            sinks.append(langfuse_sink)

        trace_sink: TraceSink = sinks[0] if len(sinks) == 1 else CompositeTraceSink(sinks)

        async with McpStdioClient(["node", str(server_js)]) as mcp:
            if mode == "mcp":
                baseline_runner: ToolRunner = HeuristicBaselineRunner()
                tool_runner: ToolRunner = McpTriageRunner(mcp)
                report = await evaluate_suite(
                    scenarios=scenarios,
                    baseline_runner=baseline_runner,
                    tool_runner=tool_runner,
                    thresholds=thresholds,
                    trace_sink=trace_sink,
                )
            else:
                shared_pacer = RequestPacer(gemini_interval_seconds)
                async with (
                    GeminiToolRunner.from_env(
                        resolved_env,
                        mcp_client=None,
                        model=gemini_model,
                        min_request_interval_seconds=gemini_interval_seconds,
                        pacer=shared_pacer,
                    ) as gemini_baseline,
                    GeminiToolRunner.from_env(
                        resolved_env,
                        mcp_client=mcp,
                        model=gemini_model,
                        min_request_interval_seconds=gemini_interval_seconds,
                        pacer=shared_pacer,
                    ) as gemini_tools,
                ):
                    report = await evaluate_suite(
                        scenarios=scenarios,
                        baseline_runner=gemini_baseline,
                        tool_runner=gemini_tools,
                        thresholds=thresholds,
                        trace_sink=trace_sink,
                    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
    return report


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agentgate-eval",
        description="Run AgentGate baseline vs. MCP-assisted CI evaluation gate.",
    )
    parser.add_argument(
        "--scenarios",
        type=Path,
        default=Path("benchmarks/scenarios.json"),
        help="Path to EvalScenario JSON array.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("benchmarks/latest-report.json"),
        help="Destination path for EvalSuiteReport JSON.",
    )
    parser.add_argument(
        "--traces",
        type=Path,
        default=Path("data/traces.jsonl"),
        help="Destination path for OpenTelemetry-shaped JSONL spans.",
    )
    parser.add_argument(
        "--mode",
        choices=("mcp", "gemini"),
        default="mcp",
        help="Evaluation runner mode: deterministic MCP ('mcp') or live Gemini ('gemini').",
    )
    parser.add_argument(
        "--min-tool-pass-rate",
        type=float,
        default=0.85,
        help="Minimum tool-assisted pass rate floor [0.0..1.0].",
    )
    parser.add_argument(
        "--min-delta",
        type=float,
        default=0.0,
        help="Minimum tool pass rate delta over baseline [-1.0..1.0].",
    )
    parser.add_argument(
        "--max-p95-ms",
        type=float,
        default=4000.0,
        help="Maximum allowed tool-assisted p95 latency in milliseconds.",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=4.5,
        help="Minimum interval in seconds between live Gemini requests.",
    )
    parser.add_argument(
        "--env-file",
        type=Path,
        default=None,
        help="Optional dotenv file merged beneath process environment variables.",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=None,
        help="Override Gemini model name (defaults to GEMINI_MODEL or gemini-3.1-flash-lite).",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Execute the AgentGate CLI evaluation gate and return 0 on pass or 1 on gate failure."""
    args = _build_parser().parse_args(argv)
    mode: Literal["mcp", "gemini"] = "gemini" if args.mode == "gemini" else "mcp"
    thresholds = GateThresholds(
        min_tool_pass_rate=float(args.min_tool_pass_rate),
        min_delta_over_baseline=float(args.min_delta),
        max_p95_latency_ms=float(args.max_p95_ms),
    )

    report = asyncio.run(
        run_benchmark(
            scenarios_path=Path(args.scenarios),
            output_path=Path(args.output),
            traces_path=Path(args.traces),
            mode=mode,
            thresholds=thresholds,
            env_file=args.env_file,
            gemini_model=args.model,
            gemini_interval_seconds=float(args.interval),
        )
    )

    gate_label = "PASS" if report.passed_ci_gate else "FAIL"
    print(
        f"AgentGate Eval [{gate_label}] cases={report.total_cases} "
        f"baseline={report.baseline_pass_rate:.2f} tool={report.tool_pass_rate:.2f} "
        f"schema={report.schema_valid_rate:.2f} injection={report.injection_block_rate:.2f} "
        f"p95_ms={report.p95_tool_latency_ms:.1f}"
    )
    if report.gate_failures:
        for failure in report.gate_failures:
            print(f" - Gate failure: {failure}")

    return 0 if report.passed_ci_gate else 1


if __name__ == "__main__":
    raise SystemExit(main())
