# AgentGate

Eval-gated MCP agent harness and HMAC-signed idempotent webhook triage system, deployed serverless-first and designed around deep modules with explicit seams.

## Problem Statement

Autonomous incident- and webhook-triage agents fail silently in three predictable ways:
1. **Unverified or replayed webhook traffic** triggers duplicate side effects and runaway API cost.
2. **Untyped or unvalidated tool calls** let malformed outputs or prompt injections mutate downstream state.
3. **Unmeasured prompt/model tweaks** ship regressions into production because there is no baseline vs. tool-use CI gate.

AgentGate pairs an HMAC-authenticated idempotent webhook receiver, a strict TypeScript MCP tool server, and a strict-typed Python SDK + eval CI gate comparing a no-tool baseline against tool-assisted agent runs.

## Architecture Overview

```text
  Webhook Caller (e.g. n8n)
        │  X-AgentGate-Timestamp + HMAC-SHA256
        ▼
  [agentgate.webhook.ingest_webhook] ──► Seam: IdempotencyStore (InMemory / SQLite / DynamoDB)
        │
        ▼
  [agentgate.evaluator.evaluate_suite]
        ├──► Mode A: Baseline Run (no tools)
        ├──► Mode B: Tool Run ──► Seam: ToolRunner ──► TypeScript MCP Server (Zod-validated tools)
        ├──► Seam: EvalJudge (deterministic assertions + adversarial injection checks)
        └──► Seam: TraceSink (InMemory / JSON / Langfuse)
        │
        ▼
  EvalSuiteReport ──► GitHub Actions CI Quality Gate & Scoreboard UI
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for module boundaries, interfaces, seams, adapters, and locked architecture decisions.

## Repository Layout

```text
AgentGate/
├── .github/workflows/ci.yml              # ruff, mypy --strict, pytest, TypeScript typecheck
├── packages/
│   ├── python-sdk/                       # Typed SDK (sync + async), HMAC webhook intake, CI evaluator
│   ├── mcp-server/                       # TypeScript MCP server (Zod-validated read-only ops tools)
│   └── dashboard/                        # Next.js App Router + Tailwind CSS scoreboard rendering EvalSuiteReport JSON (Week 2)
├── benchmarks/scenarios.json             # Seed triage & prompt-injection benchmark scenarios
├── integrations/n8n/                     # Self-hostable n8n webhook automation example
├── infra/                                # Multi-stage Dockerfile + AWS SAM deployment template
├── ARCHITECTURE.md                       # Deep-module design & locked architecture decisions
└── POSTMORTEM.md                         # Engineering failure log & mitigations template
```

## Quick Start (Local, Zero Docker Required)

### 1. Python SDK (`uv`)

```bash
cd packages/python-sdk
uv sync
uv run ruff check src tests
uv run mypy src tests
uv run pytest -v
```

### 2. TypeScript MCP Server (`npm`)

```bash
cd packages/mcp-server
npm install
npm run typecheck
npm run build
```
