# Architecture — Deep Modules & Seams

AgentGate is organized around **deep modules** placed at explicit **seams** (`typing.Protocol` in Python, Zod schemas + pure handlers in TypeScript) so every core rule can be tested in-process in milliseconds without AWS, Docker, or live LLM calls, while swapping real cloud and LLM adapters cleanly behind those interfaces.

## Modules, Interfaces, Seams & Adapters

| Module | Interface (what callers & tests rely on) | Seam | Adapters |
|---|---|---|---|
| **Webhook Intake** (`agentgate.webhook`) | `sign_payload(secret, ts, body)` and `ingest_webhook(event, signature, secret, store, now, max_age)` → returns typed `IntakeDecision` (`accepted`, `duplicate`, `rejected_signature`, `rejected_stale`) without raising on bad caller traffic | `IdempotencyStore` (`claim(key, ttl_seconds) -> bool`) | `InMemoryIdempotencyStore` (tests); `SqliteIdempotencyStore` (local zero-Docker) & `DynamoDbIdempotencyStore` conditional `PutItem` (AWS) |
| **Eval Engine** (`agentgate.evaluator`) | `evaluate_suite(scenarios, baseline_runner, tool_runner, judge, thresholds, trace_sink)` → compares no-tool baseline vs. MCP-tool runs and emits `EvalSuiteReport` with pass rates, p95 latency, tokens, and `passed_ci_gate` | `ToolRunner`, `EvalJudge`, `TraceSink` | Deterministic/scripted runners (`CI`), `GeminiToolRunner` + MCP stdio bridge (`Week 1`), `OpenAICompatibleToolRunner` (`later stage`), `InMemoryTraceSink` / local OTel-shaped JSON + optional Langfuse exporter (`Week 2`) |
| **SDK Client** (`agentgate.client`) | `AgentGateClient` (sync) and `AsyncAgentGateClient` (async) exposing `.send_signed_webhook()` and `.health()` with context-manager lifecycle | `httpx.BaseTransport` / `httpx.AsyncBaseTransport` | Live HTTP transport or `httpx.MockTransport` in tests |
| **Ops MCP Server** (`packages/mcp-server`) | Strictly typed read-only tools (`inspect_log_excerpt`, `check_latency_budget`, `lookup_runbook`) registered via `@modelcontextprotocol/sdk` | `LogRepository` / injected fixture state inside `tools.ts` | Deterministic in-repo fixtures (`Week 1`); S3/CloudWatch log reader (`Week 2`) |

## Security & Untrusted-Input Invariants

1. **Authentication & Replay Guard:** Every webhook must pass constant-time `HMAC-SHA256` verification over `{timestamp}.{raw_body}` within the allowed clock skew window before state is claimed in `IdempotencyStore`.
2. **Idempotency First:** `IdempotencyStore.claim()` runs atomically after authentication so network retries return `duplicate` instead of re-invoking agents.
3. **Read-Only Tool Boundary:** MCP diagnostic tools validate all parameters through strict Zod schemas, sanitize external untrusted strings, and never expose write/exec primitives to agent tool calls.

## Locked Architecture Decisions

1. **Dashboard UI stack:** Next.js App Router + Tailwind CSS in `packages/dashboard/` (built in Week 2).
2. **Primary persistence store:** SQLite locally (zero-Docker, atomic `BEGIN IMMEDIATE`) + AWS DynamoDB conditional `PutItem` in cloud.
3. **Live LLM adapter (`ToolRunner`):** Google Gemini (`GeminiToolRunner`) primary free-tier adapter in Week 1 with built-in `429` pacing/backoff; `OpenAICompatibleToolRunner` (Groq, OpenRouter, Mistral, Ollama, OpenAI) plugged behind the same seam in a later stage.
4. **Trace & eval observability (`TraceSink`):** Local OpenTelemetry-shaped JSON traces by default + optional Langfuse exporter when keys are configured.
5. **AWS deployment target:** Serverless AWS SAM (`infra/template.yaml`: Lambda + HTTP API + DynamoDB + S3).
