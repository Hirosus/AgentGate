# agentgate-sdk

Typed Python SDK (`AgentGateClient` / `AsyncAgentGateClient`), `v2=` HMAC-SHA256 idempotent webhook intake (`ingest_webhook` / `WebhookIngress`), FastAPI & AWS Lambda adapters, and deterministic/live evaluation harness (`evaluate_suite` / `agentgate-eval`) for AgentGate.

## Installation & Optional Extras

Requires Python `>= 3.11` and [`uv`](https://docs.astral.sh/uv/):

```bash
cd packages/python-sdk
uv sync                  # core SDK + dev lint/typecheck/test tools (httpx, pydantic)
uv sync --extra server   # adds FastAPI + Uvicorn for local HTTP webhook serving
uv sync --extra aws      # adds boto3 for DynamoDbIdempotencyStore
```

## `agentgate-eval` CLI

Build `@agentgate/mcp-server` first (`cd packages/mcp-server && npm install && npm run build`) so `packages/mcp-server/dist/index.js` exists, then run from `packages/python-sdk` (or `uv run --directory packages/python-sdk agentgate-eval ...`):

```bash
cd packages/python-sdk
# Deterministic MCP CI evaluation (default --mode mcp)
uv run agentgate-eval --scenarios ../../benchmarks/scenarios.json --output ../../benchmarks/latest-report.json --traces ../../data/traces.jsonl --min-tool-pass-rate 0.95 --min-delta 0.50

# Live Google Gemini evaluation (requires GEMINI_API_KEY in env or --env-file)
uv run agentgate-eval --mode gemini --env-file ../../.env --scenarios ../../benchmarks/scenarios.json --output ../../benchmarks/gemini-report.json --traces ../../data/gemini-traces.jsonl --interval 3.0 --max-p95-ms 20000
```

Supported flags:
- `--mode {mcp,gemini}`: evaluation runner (`mcp` default deterministic stdio runner; `gemini` live REST + MCP stdio runner)
- `--scenarios PATH`: scenario JSON array (defaults to `benchmarks/scenarios.json`)
- `--output PATH`: destination `EvalSuiteReport` JSON (defaults to `benchmarks/latest-report.json`)
- `--traces PATH`: destination OpenTelemetry-shaped JSONL trace file (defaults to `data/traces.jsonl`)
- `--mcp-server PATH`: override compiled MCP server JavaScript entrypoint
- `--min-tool-pass-rate FLOAT`: minimum tool pass rate `[0.0..1.0]` (default `0.85`)
- `--min-delta FLOAT`: minimum tool-over-baseline pass rate delta `[-1.0..1.0]` (default `0.0`)
- `--min-schema-valid-rate FLOAT`: minimum schema validity rate `[0.0..1.0]` (default `1.0`)
- `--min-injection-block-rate FLOAT`: minimum adversarial injection block rate `[0.0..1.0]` (default `1.0`)
- `--max-p95-ms FLOAT`: maximum p95 tool latency in ms (defaults to `4000.0` for `mcp`, `20000.0` for `gemini`)
- `--interval FLOAT`: minimum interval in seconds between Gemini requests (default `4.5`)
- `--env-file PATH`: optional `.env` file loaded beneath process environment variables
- `--model STR`: override Gemini model (defaults to `GEMINI_MODEL` or `gemini-3.1-flash-lite`)

## Signed Webhook Server & AWS Lambda Handler

### FastAPI ASGI Server (`agentgate.api`)

```bash
cd packages/python-sdk
uv run uvicorn agentgate.api:create_app_from_env --factory --host 127.0.0.1 --port 8000
```

`create_app_from_env` reads `AGENTGATE_WEBHOOK_SECRET`, `AGENTGATE_STORE_BACKEND` (`sqlite`, `dynamodb`, or `memory`), `AGENTGATE_SQLITE_PATH`, `IDEMPOTENCY_TABLE`, `AGENTGATE_WEBHOOK_MAX_AGE_SECONDS` (`300`), `AGENTGATE_IDEMPOTENCY_TTL_SECONDS` (`86400`), `AGENTGATE_ALLOW_LEGACY_V1` (`false`), `AGENTGATE_MAX_BODY_BYTES` (`1048576`), and `AGENTGATE_TRIAGE_MODE` (`none` or `deterministic`). It exposes `GET /health` and `POST /webhooks/triage`.

### AWS Lambda Handler (`agentgate.aws_lambda`)

`agentgate.aws_lambda.handler` adapts API Gateway HTTP API v2 and REST v1 events directly onto `WebhookIngress` (`create_ingress_from_env(os.environ)`), supporting `GET /health` and `POST /webhooks/triage` with `build_lambda_handler()` and `reset_default_handler()`.

## `v2=` HMAC Contract, `IdempotencyStore`, and SDK Clients

- **Required HTTP headers:**
  - `X-AgentGate-Timestamp`: non-negative integer Unix timestamp (seconds)
  - `X-AgentGate-Idempotency-Key`: non-empty delivery key
  - `X-AgentGate-Signature`: `v2=<64-hex>` HMAC-SHA256 over `{timestamp}.{idempotency_key}.{raw_body}`
  - `X-AgentGate-Source` *(optional)*: producer tag (defaults to `"webhook"` in `WebhookIngress`, `"sdk"` in SDK clients)
- **Legacy `v1=` opt-in:** `v1=<64-hex>` over `{timestamp}.{raw_body}` is rejected unless `allow_legacy_v1=True` (or `AGENTGATE_ALLOW_LEGACY_V1=true`).
- **`IdempotencyStore` (`claim` / `release`):** Implemented by `InMemoryIdempotencyStore`, `SqliteIdempotencyStore`, and `DynamoDbIdempotencyStore`. `WebhookIngress` calls `store.claim(key, ttl_seconds)` after HMAC and replay checks, and calls `store.release(key)` to roll back the claim if an inline `triage_runner` fails (`HTTP 503`) so retries can succeed.
- **Sync & Async Clients:** `AgentGateClient` and `AsyncAgentGateClient` provide `.health()` and `.send_signed_webhook(idempotency_key, timestamp, raw_body, *, source="sdk", content_type="application/json", raise_on_rejected=True)` signing outbound payloads with `v2=`.

## Checks

```bash
cd packages/python-sdk
uv run ruff check src tests
uv run mypy src tests
uv run pytest -v
```
