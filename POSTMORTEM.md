# Engineering Postmortem Log

> Engineering reliability & evaluation postmortem log. Every metric and failure entry below comes directly from executed runs saved in [`benchmarks/gemini-report.json`](benchmarks/gemini-report.json) and [`benchmarks/latest-report.json`](benchmarks/latest-report.json).

## 1. Live LLM Benchmark (`gemini-3.1-flash-lite`, 20 Scenarios)

### Run 2 — After Optimization (`dffc7ef` + Shared `RequestPacer`, Schema Clarifications & Batched Tool Prompt)

Run command:
```bash
uv run agentgate-eval --mode gemini --model gemini-3.1-flash-lite --env-file ../../.env --scenarios ../../benchmarks/scenarios.json --output ../../benchmarks/gemini-report.json --traces ../../data/gemini-traces.jsonl --interval 3.0 --max-p95-ms 20000
```

Artifact: [`benchmarks/gemini-report.json`](benchmarks/gemini-report.json)

| Metric | Baseline (No Tools) | MCP-Assisted (`GeminiToolRunner`) | Delta | Target Gate | Status |
|---|---:|---:|---:|---|---|
| Overall pass rate | 0.15 (3/20) | 1.00 (20/20) | +0.85 | >= 0.85 | PASS |
| Schema-valid outputs | 1.00 (20/20) | 1.00 (20/20) | 0.00 | 1.00 | PASS |
| Prompt-injection resistance | 1.00 (5/5) | 1.00 (5/5) | 0.00 | 1.00 | PASS |
| p95 wall-clock latency (ms) | 7,840.0 ms | 13,777.8 ms | +5,937.9 ms | <= 20,000.0 ms | PASS |
| p95 net latency (excl. pacing wait) | 7,840.0 ms | 7,793.8 ms | -46.1 ms | — | Measured |
| Total tokens | 5,637 | 40,363 | +34,726 | — | Measured |

- **Gate Result (`passed_ci_gate: true`):** Passed all CI gate checks (`gate_failures: []`). Sharing one `RequestPacer` across `gemini_baseline` and `gemini_tools`, clarifying `LookupRunbookSchema` symptom descriptions (`auth_failure` vs. `webhook_timeout`), and instructing Gemini to treat `check_latency_budget.recommendedSeverity` as SLA-calibrated raised live MCP accuracy from **0.85 (17/20) → 1.00 (20/20)** and cut p95 wall-clock latency from **42,665.2 ms → 13,777.8 ms** (`67.7%` reduction, with net non-pacing latency at `7,793.8 ms`).

### Run 1 — Initial Baseline Live Run (Before Optimization, commit `4482f47`)

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

- **Gate Result (`passed_ci_gate: false`):** Failed on `p95_latency_ms 42665.2 > 20000.0` due to multi-turn tool calls combined with unshared `2.5s` free-tier RPM pacing and `429`/`503` retry backoffs on tail runs (`inc-008`: 32,248.8 ms, `inc-012`: 44,092.5 ms, `inc-014`: 34,868.5 ms, `inc-019`: 42,665.2 ms).
- **Accuracy Delta:** Without tools, `gemini-3.1-flash-lite` passed only the 3 benign scenarios where `recommended_runbook` is `null` (`inc-002`, `inc-018`, `inc-020`). With live MCP tools over stdio, accuracy jumped from **15% to 85%** while preserving **100%** schema validity and **100%** resistance across all 5 adversarial prompt-injection cases.

---

## 2. Deterministic CI Harness (`HeuristicBaselineRunner` vs. `McpTriageRunner`, 20 Scenarios)

Run artifact: [`benchmarks/latest-report.json`](benchmarks/latest-report.json) (executed on every CI push via [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

| Metric | Baseline (No Tools) | MCP-Assisted (`McpTriageRunner`) | Delta | Target Gate | Status |
|---|---:|---:|---:|---|---|
| Overall pass rate | 0.15 (3/20) | 1.00 (20/20) | +0.85 | >= 0.95 | PASS |
| Schema-valid outputs | 1.00 (20/20) | 1.00 (20/20) | 0.00 | 1.00 | PASS |
| Prompt-injection resistance | 1.00 (5/5) | 1.00 (5/5) | 0.00 | 1.00 | PASS |
| p95 latency (ms) | 0.05 ms | 3.8 ms | +3.7 ms | <= 4,000.0 ms | PASS |
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
- **Symptom:** Run 1 (`gemini-3.1-flash-lite`) failed the CI gate on p95 latency (`42,665.2 ms > 20,000.0 ms` under `2.5s` pacing) and scored `tool_passed: false` on 3 scenarios (`inc-004`, `inc-005` on `webhook-ingress`; `inc-010` on `auth-gateway`) despite `schema_valid: true` and `tool_calls == 2`.
- **Root Cause:**
  1. **Unshared Pacing Locks:** `gemini_baseline` and `gemini_tools` held independent `_request_lock` / `_last_request_at` timers in [`cli.py`](packages/python-sdk/src/agentgate/cli.py), so back-to-back baseline and tool turns tripped Gemini free-tier `429` exponential backoffs (`inc-012`: `44,092.5 ms`, `inc-019`: `42,665.2 ms`).
  2. **Ambiguous Tool Schema Descriptions (`inc-004`, `inc-005`):** Live diagnostic probe showed Gemini called `lookup_runbook(symptomTag="webhook_timeout")` (`rb-webhook-retry`) instead of `auth_failure` (`rb-hmac-rotation`) because [`LookupRunbookSchema`](packages/mcp-server/src/schemas.ts) lacked `.describe(...)` disambiguating inbound HMAC/signature mismatches from outbound webhook delivery timeouts.
  3. **Subjective Severity Override (`inc-010`):** Gemini received `recommendedSeverity: "high"` from `check_latency_budget` and `"rb-tls-renewal"` from `lookup_runbook`, then subjectively upgraded severity to `"critical"`.
  4. **Sparse Report Diagnostics:** [`EvalCaseResult`](packages/python-sdk/src/agentgate/types.py) lacked predicted `severity`/`recommended_runbook`, baseline schema/injection/token/p95 aggregates, and pacing-wait tracking.
- **Fix / Guardrail Added:**
  - Added `.describe(...)` disambiguations on all MCP tool schemas in [`packages/mcp-server/src/schemas.ts`](packages/mcp-server/src/schemas.ts) and updated tool descriptions in [`packages/mcp-server/src/index.ts`](packages/mcp-server/src/index.ts).
  - Introduced shared [`RequestPacer`](packages/python-sdk/src/agentgate/llm_gemini.py) across baseline and tool `GeminiToolRunner` instances in [`cli.py`](packages/python-sdk/src/agentgate/cli.py), updated `_build_system_instruction` to batch parallel MCP calls and treat `check_latency_budget.recommendedSeverity` as authoritative, and tracked `pacing_wait_ms` alongside net latency.
  - Extended [`EvalCaseResult`](packages/python-sdk/src/agentgate/types.py) and [`EvalSuiteReport`](packages/python-sdk/src/agentgate/types.py) with baseline metrics, predicted severity/runbook, `tool_calls`, and `p95_tool_net_latency_ms`, and surfaced them in [`ScenarioDetailPanel.tsx`](packages/dashboard/src/components/ScenarioDetailPanel.tsx).
- **Regression Test & Verified After-Run:** `MCP stdio server integration` in [`packages/mcp-server/tests/tools.test.ts`](packages/mcp-server/tests/tools.test.ts), `test_shared_request_pacer_enforces_interval_across_runners_and_reports_wait` and `test_gemini_executes_parallel_multi_tool_calls_in_single_turn_over_live_stdio` in [`packages/python-sdk/tests/test_llm_gemini.py`](packages/python-sdk/tests/test_llm_gemini.py), and [`test_evaluate_suite_passes_ci_gate_when_tools_beat_baseline`](packages/python-sdk/tests/test_evaluator.py). In Run 2, tool accuracy improved **0.85 → 1.00 (20/20)** (`inc-004`, `inc-005`, `inc-010` all passed) and p95 latency dropped **42,665.2 ms → 13,777.8 ms** (`passed_ci_gate: true`).

---

## 4. Verified CI Regression Gate Test & Live Webhook Delivery

- **GitHub Actions PR Regression Gate ([PR #1](https://github.com/Hirosus/AgentGate/pull/1), closed):**
  - Pushed temporary branch `test/verify-eval-ci-gate` (`f3fd558`) disabling `dns_resolution_failure` keywords in `McpTriageRunner`.
  - GitHub Actions run [`44626350885`](https://github.com/Hirosus/AgentGate/actions/runs/44626350885) failed the `python-sdk` job as designed (`uv run pytest -v` exited `1` on `test_cli_main_passes_20_case_mcp_gate_and_writes_report_and_traces` after printing `AgentGate Eval [FAIL] cases=20 baseline=0.15 tool=0.90 schema=1.00 injection=1.00 p95_ms=1.9` and `- Gate failure: tool_pass_rate 0.90 < 0.95`). Running `agentgate-eval --min-tool-pass-rate 0.95 --min-delta 0.50` standalone on that branch likewise exited `1` (`tool=0.90`, `p95_ms=4.1`). Closed PR #1 and deleted both remote and local `test/verify-eval-ci-gate` refs.
- **Zero-Docker Linux `x86_64` AWS Lambda Bundle ([`infra/build_lambda.py`](infra/build_lambda.py)):**
  - Verified `python infra/build_lambda.py` assembled `infra/build/lambda/` (`346` files, `9.22 MB`) targeting `x86_64-manylinux2014` (`python3.11`), containing `_pydantic_core.cpython-311-x86_64-linux-gnu.so` (`5,019,000` bytes) and zero Windows `.pyd` binaries, matching [`infra/template.yaml`](infra/template.yaml).
- **Live FastAPI + SQLite Signed Webhook Round-Trip ([`integrations/n8n/alert-triage-workflow.json`](integrations/n8n/alert-triage-workflow.json)):**
  - Verified against a live local `uvicorn` TCP HTTP server + SQLite store simulating the 4-node n8n envelope (`Prepare Signing Envelope` single-timestamp capture + `Compute HMAC-SHA256` + raw body POST): `GET /health` -> `200`, initial delivery -> `200` (`accepted`), replay -> `200` (`duplicate`), tampered body -> `401` (`rejected_signature`), stale timestamp -> `401` (`rejected_stale`).
