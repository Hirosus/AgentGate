# Engineering Postmortem Log

> Engineering reliability & evaluation postmortem log. Every metric and failure entry below comes directly from executed runs saved in [`benchmarks/gemini-report.json`](benchmarks/gemini-report.json) and [`benchmarks/latest-report.json`](benchmarks/latest-report.json).

## 1. Live LLM Benchmark (`gemini-3.1-flash-lite`, 20 Scenarios)

Run command:
```bash
uv run agentgate-eval --mode gemini --model gemini-3.1-flash-lite --env-file ../../.env --scenarios ../../benchmarks/scenarios.json --output ../../benchmarks/gemini-report.json --traces ../../data/gemini-traces.jsonl --interval 2.5 --max-p95-ms 20000
```

| Metric | Baseline (No Tools) | MCP-Assisted (`GeminiToolRunner`) | Delta | Target Gate | Status |
|---|---:|---:|---:|---|---|
| Overall pass rate | 0.15 (3/20) | 0.85 (17/20) | +0.70 | >= 0.85 | PASS |
| Schema-valid outputs | — | 1.00 (20/20) | — | 1.00 | PASS |
| Prompt-injection resistance | — | 1.00 (5/5) | — | 1.00 | PASS |
| p95 latency (ms) | — | 42,665.2 ms | — | <= 20,000.0 ms | FAIL |
| Total tool tokens | — | 25,449 | — | — | Measured |

- **Gate Result (`passed_ci_gate: false`):** Failed on `p95_latency_ms 42665.2 > 20000.0` due to multi-turn tool calls combined with `2.5s` free-tier RPM pacing and `429`/`503` retry backoffs on tail runs (`inc-008`: 32,248.8 ms, `inc-012`: 44,092.5 ms, `inc-014`: 34,868.5 ms, `inc-019`: 42,665.2 ms).
- **Accuracy Delta:** Without tools, `gemini-3.1-flash-lite` passed only the 3 benign scenarios where `recommended_runbook` is `null` (`inc-002`, `inc-018`, `inc-020`). With live MCP tools over stdio, accuracy jumped from **15% to 85%** while preserving **100%** schema validity and **100%** resistance across all 5 adversarial prompt-injection cases.

---

## 2. Deterministic CI Harness (`HeuristicBaselineRunner` vs. `McpTriageRunner`, 20 Scenarios)

Run artifact: [`benchmarks/latest-report.json`](benchmarks/latest-report.json) (executed on every CI push via [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

| Metric | Baseline (No Tools) | MCP-Assisted (`McpTriageRunner`) | Delta | Target Gate | Status |
|---|---:|---:|---:|---|---|
| Overall pass rate | 0.15 (3/20) | 1.00 (20/20) | +0.85 | >= 0.95 | PASS |
| Schema-valid outputs | — | 1.00 (20/20) | — | 1.00 | PASS |
| Prompt-injection resistance | — | 1.00 (5/5) | — | 1.00 | PASS |
| p95 latency (ms) | — | 3.5 ms | — | <= 4,000.0 ms | PASS |
| Total tokens | 0 | 0 | 0 | — | Offline CI |

---

## 3. Logged Failure Modes & Mitigations

### Failure 1 — Gemini Model Deprecation (`404`) & High-Demand Spike (`503`)
- **Symptom:** Initial live API verification against `gemini-2.5-flash` failed with HTTP `404` (`"This model models/gemini-2.5-flash is no longer available to new users"`), and a follow-up check against `gemini-3.8-flash` failed with HTTP `503` (`"This model is currently experiencing high demand"`).
- **Root Cause:** Free-tier model availability rotated in Gemini AI Studio (`v1beta`), and flagship Flash variants experience transient capacity spikes.
- **Fix / Guardrail Added:** Switched default model in `.env.example`, `GeminiConfig`, and `GeminiToolRunner.from_env` to `gemini-3.1-flash-lite` (verified live with `tool_calls=2` on `inc-001`), raised `from_env` defaults to `max_retries=5` and `initial_backoff_seconds=2.0`, and honored HTTP `Retry-After` headers plus pacing lock.
- **Regression Test:** `test_gemini_retries_on_429_and_enforces_request_pacing` and `test_gemini_from_env_validation` in [`packages/python-sdk/tests/test_llm_gemini.py`](packages/python-sdk/tests/test_llm_gemini.py).

### Failure 2 — MCP JSON Schema Keywords Rejected by Gemini `functionDeclarations`
- **Symptom:** Raw `tools/list` schemas returned by `@modelcontextprotocol/sdk` (`zod`) include `$schema`, `additionalProperties`, `default`, `minLength`, `maxLength`, `minimum`, `maximum`, and `pattern`, which Gemini's `v1beta` `functionDeclarations.parameters` schema validator rejects.
- **Root Cause:** Standard JSON Schema Draft-07 metadata emitted by Zod does not map 1:1 to Gemini's OpenAPI schema subset.
- **Fix / Guardrail Added:** Added recursive [`sanitize_gemini_schema`](packages/python-sdk/src/agentgate/llm_gemini.py) filtering schema nodes down to `{"type", "description", "enum", "properties", "required", "items"}` while keeping strict Zod enforcement intact inside the TypeScript MCP server boundary.
- **Regression Test:** `test_sanitize_gemini_schema_strips_unsupported_json_schema_keywords_from_live_mcp` in [`packages/python-sdk/tests/test_llm_gemini.py`](packages/python-sdk/tests/test_llm_gemini.py).

### Failure 3 — Benchmark Expansion Test Drift (`2` → `20` Scenarios)
- **Symptom:** After expanding `benchmarks/scenarios.json` from 2 seed cases to 20 scenarios, `test_mcp_triage_runner_beats_baseline_on_seed_scenarios_over_live_stdio` failed with `AssertionError: assert 0.1 == 0.5`.
- **Root Cause:** The seed test read the shared `benchmarks/scenarios.json` file expecting `baseline_pass_rate == 0.5` (`1/2`), whereas the 20-case suite lowered the naive baseline pass rate to `0.10` (`2/20`).
- **Fix / Guardrail Added:** Scoped the seed integration test to `raw_scenarios[:2]` and added dedicated 20-case CLI gate assertions in [`packages/python-sdk/tests/test_cli.py`](packages/python-sdk/tests/test_cli.py).
- **Regression Test:** `test_cli_main_passes_20_case_mcp_gate_and_writes_report_and_traces` in [`packages/python-sdk/tests/test_cli.py`](packages/python-sdk/tests/test_cli.py).

### Failure 4 — Live Gemini Free-Tier Latency Breach & 3 Misses (`inc-004`, `inc-005`, `inc-010`)
- **Symptom:** The live 20-case `gemini-3.1-flash-lite` run failed the CI gate on p95 latency (`42,665.2 ms > 20,000.0 ms` under `2.5s` pacing) and scored `tool_passed: false` on 3 scenarios (`inc-004`, `inc-005` on `webhook-ingress`; `inc-010` on `auth-gateway`) despite `schema_valid: true` and `tool_calls == 2` recorded in `gemini-traces.jsonl`.
- **Root Cause:** (1) Multi-turn tool calls multiplied by free-tier RPM pacing and exponential `429`/`503` retries pushed tail latency above 42s; (2) `EvalCaseResult` records pass/fail booleans without capturing per-case predicted `severity` / `recommended_runbook` fields, making post-run diagnosis of the 3 classification misses require re-running or enriching report diagnostics.
- **Next Guardrail (Week 2):** Record predicted `severity`, `recommended_runbook`, and `category` in trace metadata / `EvalCaseResult` diagnostics, tune the system prompt around `webhook-ingress` (`rb-hmac-rotation`) vs. `auth-gateway` (`rb-tls-renewal`), and keep free-tier paced LLM evals separate from fast deterministic CI PR gates.
