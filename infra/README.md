# AgentGate Cloud Deployment Guide (AWS SAM + n8n + Vercel)

Deploy the serverless webhook ingress to AWS Lambda + HTTP API + DynamoDB + S3, wire the signed webhook producer in n8n, and host the eval scoreboard UI on Vercel.

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

Because AWS Lambda runs Linux `x86_64` (`python3.11`) and `pydantic_core` ships native binaries, assemble `infra/build/lambda/` with Linux manylinux wheels before running `sam deploy` (no Docker container required):

```bash
python infra/build_lambda.py
```

This installs `pydantic` and `httpx` Linux `x86_64` wheels (`--python-platform x86_64-manylinux2014`), copies `packages/python-sdk/src/agentgate/`, verifies `_pydantic_core*.so` is present with zero Windows `.pyd` files, and outputs to the gitignored `infra/build/lambda/` folder referenced by `infra/template.yaml`.

---

## 3. Deploy AWS SAM Stack

From `infra/`:

```bash
sam validate --template-file template.yaml
sam deploy --template-file template.yaml \
  --stack-name agentgate-prod \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --parameter-overrides WebhookSecret="REPLACE_WITH_32_PLUS_CHAR_SECRET"
```

Capture the stack outputs `HealthEndpointUrl` and `WebhookEndpointUrl` (base URL without trailing path is `AGENTGATE_BASE_URL`).

---

## 4. Smoke-Test the Live Webhook Endpoint

```python
import json
import time
from agentgate.client import AgentGateClient

base_url = "https://<api-id>.execute-api.<region>.amazonaws.com"
secret = "REPLACE_WITH_32_PLUS_CHAR_SECRET"
body = json.dumps({"event_id": "smoke-001", "service": "checkout-api", "p95_ms": 820}).encode()

with AgentGateClient(base_url, secret) as client:
    assert client.health() is True
    first = client.send_signed_webhook("smoke-001", int(time.time()), body)
    second = client.send_signed_webhook("smoke-001", int(time.time()), body)
    print(first.status, second.status)  # accepted, duplicate
```

---

## 5. Connect n8n Signed Webhook Producer

Import [`integrations/n8n/alert-triage-workflow.json`](../integrations/n8n/alert-triage-workflow.json) into n8n Cloud (or local `npx n8n`) and configure environment variables:

- `AGENTGATE_BASE_URL`: deployed HTTP API base URL from Step 3
- `AGENTGATE_WEBHOOK_SECRET`: matching HMAC secret configured in SAM

The workflow captures a single Unix timestamp in `Prepare Signing Envelope`, signs `${timestamp}.${rawBody}` via HMAC-SHA256 in `Compute HMAC-SHA256`, and sends `X-AgentGate-Timestamp`, `X-AgentGate-Idempotency-Key`, and `X-AgentGate-Signature: v1=...` with the exact `rawBody`.

---

## 6. Host the Next.js Scoreboard UI (`packages/dashboard`) on Vercel

1. Connect `Hirosus/AgentGate` in Vercel (or via the Vercel plugin).
2. Set **Root Directory** to `packages/dashboard`.
3. Keep the **Next.js** preset (`npm install`, `npm run build`). Pre-synced artifacts under `packages/dashboard/src/data/` ensure standalone Vercel builds work without monorepo parent directories.
