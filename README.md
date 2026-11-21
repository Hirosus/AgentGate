# AgentGate

Eval-gated MCP agent harness, HMAC-SHA256 v2 idempotent webhook triage ingress, and interactive operations console designed around deep modules with explicit seams.

## Problem Statement

Autonomous incident- and webhook-triage agents fail silently in three predictable ways:
1. **Unverified or replayed webhook traffic** triggers duplicate side effects and runaway API cost.
2. **Untyped or unvalidated tool calls** let malformed outputs or prompt injections mutate downstream state.
3. **Unmeasured prompt/model tweaks** ship regressions into production because there is no baseline vs. tool-use CI gate.

AgentGate pairs an HMAC-authenticated idempotent webhook receiver, a strict Zod-validated TypeScript MCP tool server, a strict-typed Python SDK + eval CI gate, and a Next.js 15 operations console.

## Architecture Overview

AgentGate operates across three cleanly separated planes:

1. **Signed Webhook Ingress (`agentgate.webhook`, `agentgate.ingress`, `agentgate.api`, `agentgate.aws_lambda`):**
   - Requires `v2=` HMAC-SHA256 signatures binding `{timestamp}.{idempotency_key}.{raw_body}` (with opt-in `allow_legacy_v1` / `AGENTGATE_ALLOW_LEGACY_V1` migration support) and enforces replay-window checks before claiming keys atomically in `IdempotencyStore` (`SqliteIdempotencyStore` in WAL mode locally, `DynamoDbIdempotencyStore` conditional `PutItem` on AWS, or `InMemoryIdempotencyStore` in tests).
   - Supports an optional inline deterministic triage hook via `AGENTGATE_TRIAGE_MODE=deterministic` (or custom `triage_runner`) with automatic `IdempotencyStore.release()` rollback (`HTTP 503`) if triage execution raises.

2. **Eval & MCP Harness (`agentgate-eval`, `agentgate.evaluator`, `@agentgate/mcp-server`):**
   - `agentgate-eval` launches `@agentgate/mcp-server` (`packages/mcp-server/dist/index.js`) over stdio JSON-RPC (`McpStdioClient`), backed by the canonical diagnostic catalog [`packages/mcp-server/src/catalog.json`](packages/mcp-server/src/catalog.json) and strict Zod input schemas.
   - Compares a no-tool baseline against tool-assisted runs (`McpTriageRunner` for deterministic CI or `GeminiToolRunner` with shared `RequestPacer` for live Gemini runs) through `DeterministicJudge`, emitting OTel-shaped JSONL (`JsonlOtelTraceSink`) and optional Langfuse (`LangfuseTraceSink`) spans plus `benchmarks/*.json` reports.

3. **Interactive Operations Console (`packages/dashboard`):**
   - Next.js 15 (`App Router`, React 19, Tailwind CSS v4) console consuming synced [`packages/dashboard/src/data/`](packages/dashboard/src/data/) artifacts (`scenarios.json`, `latest-report.json`, `gemini-report.json`, `mcp-catalog.json`) alongside live same-origin `/api/triage` and `/api/triage/reset` endpoints for simulating `v2=` HMAC gating, tamper/replay/stale faults, and Instant MCP vs. Live AI triage.

```text
  Plane 1: Signed Webhook Ingress
    Caller (n8n / SDK) ──► POST /webhooks/triage (X-AgentGate-Timestamp, Idempotency-Key, Signature v2=)
        ──► WebhookIngress / ingest_webhook ──► IdempotencyStore (claim / release) ──► FastAPI (:8000) or AWS Lambda

  Plane 2: Eval & MCP Harness
    agentgate-eval ──► evaluate_suite (Baseline vs. McpTriageRunner / GeminiToolRunner)
        ──► McpStdioClient ──► @agentgate/mcp-server (catalog.json + Zod tools)
        ──► DeterministicJudge + TraceSink (JSONL OTel / Langfuse) ──► benchmarks/*.json

  Plane 3: Interactive Operations Console (Next.js 15)
    packages/dashboard ──► /api/triage & /api/triage/reset (Live Triage Workbench)
                       ──► synced src/data/{scenarios,latest-report,gemini-report,mcp-catalog}.json
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for exact module interfaces, `seams.py` protocols, adapters, and invariants, and [POSTMORTEM.md](POSTMORTEM.md) for measured benchmark runs and logged failure modes.

## Webhook HTTP Headers

All requests to `POST /webhooks/triage` require:
- `X-AgentGate-Timestamp`: non-negative Unix epoch integer (seconds)
- `X-AgentGate-Idempotency-Key`: non-empty delivery identifier
- `X-AgentGate-Signature`: `v2=<64-hex>` HMAC-SHA256 digest over `{timestamp}.{idempotency_key}.{raw_body}` (`v1=<64-hex>` over `{timestamp}.{raw_body}` is accepted only when `AGENTGATE_ALLOW_LEGACY_V1=true`)
- `X-AgentGate-Source` *(optional)*: producer identifier (defaults to `"webhook"` in `WebhookIngress`, `"sdk"` in `AgentGateClient` / `AsyncAgentGateClient`)

## Repository Layout

```text
AgentGate/
├── .github/workflows/ci.yml              # CI: MCP build/typecheck/test, Python lint/mypy/pytest/eval gate, dashboard typecheck/sync/test/build
├── .env.example                          # Documented environment variables for ingress, stores, Gemini, Langfuse, and n8n
├── packages/
│   ├── mcp-server/                       # TypeScript MCP server (Zod-validated read-only ops tools + canonical src/catalog.json)
│   ├── python-sdk/                       # Typed Python SDK (sync + async), WebhookIngress, FastAPI/Lambda adapters, agentgate-eval CLI
│   └── dashboard/                        # Next.js 15 App Router operations console (Live Triage Workbench + Eval Benchmarks + Runbooks)
├── benchmarks/                           # 20-scenario suite (scenarios.json) + CI (latest-report.json) & Gemini (gemini-report.json) reports
├── integrations/n8n/                     # Self-hostable / n8n Cloud v2= signed webhook triage workflow
├── infra/                                # Multi-stage Dockerfile (:8000 Uvicorn), build_lambda.py, least-privilege SAM template.yaml
├── ARCHITECTURE.md                       # Deep-module boundaries, Protocol seams, exact signatures, and architectural decisions
└── POSTMORTEM.md                         # Engineering postmortem log with executed benchmark runs and regression mitigations
```

## Quick Start (Local, Zero Docker Required)

> [!IMPORTANT]
> Build `@agentgate/mcp-server` **first**. Python SDK MCP integration and CLI tests spawn `packages/mcp-server/dist/index.js` over stdio and fail if the TypeScript build output is missing.

### 1. Build & Test TypeScript MCP Server (`packages/mcp-server`)

```bash
cd packages/mcp-server
npm install && npm run build && npm test
npm run typecheck
```

PowerShell note: run commands sequentially (or separate with `; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`) instead of `&&` when using Windows PowerShell 5.1.

### 2. Python SDK, Tests & `agentgate-eval` (`packages/python-sdk`)

```bash
cd packages/python-sdk
uv sync --extra server
uv run ruff check src tests
uv run ruff check ../../infra/build_lambda.py
uv run mypy src tests
uv run pytest -v
```

Run the deterministic 20-scenario CI eval gate:

```bash
cd packages/python-sdk
uv run agentgate-eval --scenarios ../../benchmarks/scenarios.json --output ../../benchmarks/latest-report.json --traces ../../data/traces.jsonl --min-tool-pass-rate 0.95 --min-delta 0.50
```

Run the live Gemini evaluation (requires `GEMINI_API_KEY` in environment or `--env-file`):

```bash
cd packages/python-sdk
uv run agentgate-eval --mode gemini --env-file ../../.env --scenarios ../../benchmarks/scenarios.json --output ../../benchmarks/gemini-report.json --traces ../../data/gemini-traces.jsonl --interval 3.0 --max-p95-ms 20000
```

Run the local signed webhook server (`uvicorn` + SQLite WAL store; set `AGENTGATE_WEBHOOK_SECRET` first, see [`.env.example`](.env.example)):

```bash
cd packages/python-sdk
uv run uvicorn agentgate.api:create_app_from_env --factory --host 127.0.0.1 --port 8000
```

### 3. Operations Console (`packages/dashboard`)

```bash
cd packages/dashboard
npm install
npm test
npm run typecheck
npm run dev
```

`npm run dev`, `npm run typecheck`, and `npm run build` sync `benchmarks/*.json` and `packages/mcp-server/src/catalog.json` into `packages/dashboard/src/data/`.

## CI Checks

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) enforces three jobs on every push and pull request to `main`:
- **`python-sdk`:** builds `@agentgate/mcp-server` (`npm ci && npm run build`), runs `uv sync --frozen`, `uv run ruff check src tests`, `uv run ruff check ../../infra/build_lambda.py`, `uv run mypy src tests`, `uv run pytest -v`, and the 20-scenario `agentgate-eval` gate (`--min-tool-pass-rate 0.95 --min-delta 0.50`).
- **`mcp-server`:** runs `npm ci`, `npm run typecheck`, and `npm test`.
- **`dashboard`:** runs `npm ci`, `npm run typecheck`, verifies synced `packages/dashboard/src/data` matches upstream files (`git diff --exit-code packages/dashboard/src/data`), `npm test`, and `npm run build`.

## Package & Deployment Guides

- [`.env.example`](.env.example) — Active environment variables and defaults
- [`packages/python-sdk/README.md`](packages/python-sdk/README.md) — Python SDK, CLI flags, `WebhookIngress`, and `v2=` HMAC contract
- [`packages/dashboard/README.md`](packages/dashboard/README.md) — Next.js 15 Live Triage & Eval Operations Console and Vercel deployment
- [`infra/README.md`](infra/README.md) — Zero-Docker Linux `x86_64` Lambda packaging (`infra/build_lambda.py`), least-privilege AWS SAM deployment (`infra/template.yaml` without S3), container image (`infra/Dockerfile` serving Uvicorn on `:8000`), and n8n workflow wiring
