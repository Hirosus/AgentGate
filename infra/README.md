# AgentGate Deployment Guide (AWS SAM + Docker + n8n + Vercel)

Deploy the serverless `v2=` signed webhook ingress on AWS Lambda + HTTP API + DynamoDB (least-privilege IAM, no S3 bucket) or via Docker/Uvicorn, wire the n8n signed webhook producer, and host the Next.js 15 operations console on Vercel.

---

## 1. Prerequisites (Windows / macOS / Linux)

Install AWS CLI v2 and AWS SAM CLI, then configure IAM credentials:

```powershell
winget install Amazon.AWSCLI Amazon.SAM-CLI
aws configure
```

Confirm `uv` (`>= 0.5`) is available for zero-Docker cross-platform Lambda packaging.

---

## 2. Build Zero-Docker Linux `x86_64` Lambda Bundle

Because AWS Lambda runs Linux `x86_64` (`python3.11`) and `pydantic_core` ships native binaries, assemble `infra/build/lambda/` with Linux manylinux wheels before running `sam deploy`:

```bash
python infra/build_lambda.py
```

`build_lambda.py` installs `[project].dependencies` from `packages/python-sdk/pyproject.toml` (`httpx`, `pydantic`) for `--python-platform x86_64-manylinux2014` (`3.11`), copies `packages/python-sdk/src/agentgate/`, verifies `_pydantic_core*.so` is present with zero Windows `.pyd` files, and writes to the gitignored `infra/build/lambda/` directory referenced by [`infra/template.yaml`](template.yaml).

---

## 3. Deploy AWS SAM Stack (Least-Privilege DynamoDB, No S3)

[`infra/template.yaml`](template.yaml) provisions:
- `IdempotencyTable` (`AWS::DynamoDB::Table`, `PAY_PER_REQUEST`, TTL on `expires_at`)
- `WebhookIntakeFunction` (`agentgate.aws_lambda.handler`, `python3.11`, `x86_64`) with least-privilege IAM scoped strictly to `dynamodb:PutItem` and `dynamodb:DeleteItem` on `IdempotencyTable.Arn` (no S3 bucket is provisioned)
- HTTP API routes `GET /health` and `POST /webhooks/triage`

SAM parameters:
- `WebhookSecret` *(required, `NoEcho: true`, `MinLength: 32`)* — shared HMAC-SHA256 secret
- `IdempotencyTtlSeconds` *(optional, default `86400`, `MinValue: 60`)* — TTL for stored DynamoDB claims
- `TriageMode` *(optional, default `none`, allowed: `none` | `deterministic`)* — inline webhook triage behavior (`none` for intake-only; `deterministic` to attach inline `run_deterministic_triage` output with automatic `DeleteItem` rollback on error)

**Bash:**
```bash
cd infra
sam validate --template-file template.yaml
sam deploy --template-file template.yaml \
  --stack-name agentgate-prod \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --parameter-overrides \
    WebhookSecret="REPLACE_WITH_32_PLUS_CHAR_SECRET" \
    IdempotencyTtlSeconds=86400 \
    TriageMode=none
```

**PowerShell:**
```powershell
Set-Location infra
sam validate --template-file template.yaml; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
sam deploy --template-file template.yaml `
  --stack-name agentgate-prod `
  --capabilities CAPABILITY_IAM `
  --resolve-s3 `
  --parameter-overrides `
    WebhookSecret="REPLACE_WITH_32_PLUS_CHAR_SECRET" `
    IdempotencyTtlSeconds=86400 `
    TriageMode=none
```

Capture the stack outputs `HealthEndpointUrl` and `WebhookEndpointUrl` (the base URL without trailing route path is `AGENTGATE_BASE_URL`).

---

## 4. Container Image Alternative (`infra/Dockerfile`)

For container-based deployments (local Docker, ECS, Cloud Run, Fly.io), [`infra/Dockerfile`](Dockerfile) installs `packages/python-sdk` with `--extra server` via `uv sync --frozen --no-dev --extra server` and runs FastAPI/Uvicorn (`agentgate.api:create_app_from_env --factory`) on port `8000` as non-root user `agentgate`:

```bash
docker build -f infra/Dockerfile -t agentgate-ingress .
docker run --rm -p 8000:8000 -e AGENTGATE_WEBHOOK_SECRET="REPLACE_WITH_32_PLUS_CHAR_SECRET" agentgate-ingress
```

---

## 5. Smoke-Test the Live Webhook Endpoint (`v2=` Signed)

Run the Python smoke check through `uv run --directory packages/python-sdk` (from the repository root) so `agentgate` and `httpx`/`pydantic` resolve cleanly inside the SDK environment:

**Bash:**
```bash
uv run --directory packages/python-sdk python -c '
import json, time
from agentgate.client import AgentGateClient

base_url = "https://<api-id>.execute-api.<region>.amazonaws.com"
secret = "REPLACE_WITH_32_PLUS_CHAR_SECRET"
body = json.dumps({"event_id": "smoke-001", "service": "checkout-api", "p95_ms": 820}).encode()

with AgentGateClient(base_url, secret) as client:
    assert client.health() is True
    first = client.send_signed_webhook("smoke-001", int(time.time()), body)
    second = client.send_signed_webhook("smoke-001", int(time.time()), body)
    print(first.status, second.status)  # accepted duplicate
'
```

**PowerShell:**
```powershell
$script = @'
import json, time
from agentgate.client import AgentGateClient

base_url = "https://<api-id>.execute-api.<region>.amazonaws.com"
secret = "REPLACE_WITH_32_PLUS_CHAR_SECRET"
body = json.dumps({"event_id": "smoke-001", "service": "checkout-api", "p95_ms": 820}).encode()

with AgentGateClient(base_url, secret) as client:
    assert client.health() is True
    first = client.send_signed_webhook("smoke-001", int(time.time()), body)
    second = client.send_signed_webhook("smoke-001", int(time.time()), body)
    print(first.status, second.status)
'@
uv run --directory packages/python-sdk python -c $script
```

---

## 6. Connect n8n Signed Webhook Producer (`v2=`)

Import [`integrations/n8n/alert-triage-workflow.json`](../integrations/n8n/alert-triage-workflow.json) into local/self-hosted n8n or n8n Cloud:

- **Self-hosted / local n8n:** set `AGENTGATE_BASE_URL` and `AGENTGATE_WEBHOOK_SECRET` as process environment variables (`$env.*`).
- **n8n Cloud:** configure `AGENTGATE_BASE_URL` and `AGENTGATE_WEBHOOK_SECRET` under **Variables** (`$vars.*`).

The workflow expression supports both cleanly (`$env?.VAR || $vars?.VAR`) and executes four nodes:
1. `Alert Trigger` (`POST /webhook/agentgate-source-alert`)
2. `Prepare Signing Envelope` captures one Unix timestamp (`$now.toUnixInteger()`), `idempotencyKey` (`event_id` or `'n8n-' + $execution.id`), and serialized `rawBody`.
3. `Compute HMAC-SHA256` signs `${timestamp}.${idempotencyKey}.${rawBody}` via HMAC-SHA256 (`hex`).
4. `POST to AgentGate Ingress` sends `X-AgentGate-Source: n8n`, `X-AgentGate-Timestamp`, `X-AgentGate-Idempotency-Key`, and `X-AgentGate-Signature: v2=<hex>` with the exact `rawBody` to `${AGENTGATE_BASE_URL}/webhooks/triage`.

---

## 7. Host the Next.js 15 Operations Console (`packages/dashboard`) on Vercel

1. Connect `Hirosus/AgentGate` in Vercel and set **Root Directory** to `packages/dashboard`.
2. Keep the **Next.js** preset (`npm install`, `npm run build`). Pre-synced artifacts under `packages/dashboard/src/data/` (`scenarios.json`, `latest-report.json`, `gemini-report.json`, `mcp-catalog.json`) ensure standalone Vercel builds succeed without parent monorepo paths.
3. Configure Vercel environment variables:
   - `GEMINI_API_KEY`: enables Live AI Gemini MCP function calling in `/api/triage` (optional; falls back safely to deterministic MCP when unset)
   - `AGENTGATE_DEMO_WEBHOOK_SECRET` *(or `AGENTGATE_WEBHOOK_SECRET`)*: signs demo webhook envelopes and the `agentgate_demo_keys` cookie ledger
   - `GEMINI_MODEL` *(optional)*: overrides Gemini model (defaults to `gemini-3.1-flash-lite`)
   - `AGENTGATE_WEBHOOK_MAX_AGE_SECONDS` *(optional)*: replay window in seconds (defaults to `300`)
