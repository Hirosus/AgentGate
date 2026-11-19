# Engineering Postmortem Log

> Engineering reliability & evaluation postmortem log. Record real failure modes uncovered during benchmarking and deployment rather than sanitizing failures away.

## Benchmark Baseline vs. Tool-Use Summary *(fill in after Week 1 20-case run)*

| Metric | Baseline (No Tools) | MCP-Assisted (`AgentGate`) | Delta | Target Gate |
|---|---:|---:|---:|---|
| Overall pass rate | TBD | TBD | TBD | >= 0.85 |
| Schema-valid outputs | TBD | TBD | TBD | 1.00 |
| Prompt-injection resistance | TBD | TBD | TBD | 1.00 |
| p95 latency (ms) | TBD | TBD | TBD | <= 4,000 ms |

## Logged Failure Modes *(populate during Week 1–2 build)*

### Example Slot 1 — Duplicate Webhook Retry Storm / Partial State
- **Symptom:**
- **Root Cause:**
- **Fix / Guardrail Added:**
- **Regression Test:**

### Example Slot 2 — Prompt Injection Inside Untrusted Log Payload
- **Symptom:**
- **Root Cause:**
- **Fix / Guardrail Added:**
- **Regression Test:**
