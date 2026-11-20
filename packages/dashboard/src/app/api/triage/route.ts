import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import {
  checkLiveAiRateLimit,
  claimIdempotencyKey,
  getDemoIdempotencyMap,
  getDemoLiveRateMap,
  LEDGER_COOKIE_NAME,
  parseSignedLedgerCookie,
  resolveDemoSigningSecret,
  runBaselineHeuristic,
  runDeterministicMcpTriage,
  runGeminiMcpTriage,
  serializeSignedLedgerCookie,
  signWebhookPayload,
  verifyWebhookSignature,
  type EngineMode,
  type FaultMode,
  type PipelineStageResult,
  type TriageApiResponse,
} from "@/lib/triageEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AGE_SECONDS = 300;
const TTL_SECONDS = 86_400;

interface TriagePostBody {
  readonly mode?: unknown;
  readonly fault?: unknown;
  readonly idempotencyKey?: unknown;
  readonly service?: unknown;
  readonly p95Ms?: unknown;
  readonly payloadText?: unknown;
}

function parseMode(raw: unknown): EngineMode {
  return raw === "live_ai" ? "live_ai" : "deterministic_mcp";
}

function parseFault(raw: unknown): FaultMode {
  if (raw === "duplicate_replay" || raw === "tamper_body" || raw === "stale_timestamp") {
    return raw;
  }
  return "valid";
}

export async function GET(): Promise<NextResponse> {
  const secret = resolveDemoSigningSecret();
  const cookieStore = await cookies();
  const nowSec = Math.floor(Date.now() / 1000);
  const cookieKeys = parseSignedLedgerCookie(
    cookieStore.get(LEDGER_COOKIE_NAME)?.value,
    secret,
    nowSec,
  );
  const memMap = getDemoIdempotencyMap();
  const merged = new Set<string>(Object.keys(cookieKeys));
  for (const [k, exp] of memMap.entries()) {
    if (exp > nowSec) {
      merged.add(k);
    }
  }

  return NextResponse.json({
    liveAiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
    claimedKeyCount: merged.size,
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const startedAt = performance.now();
  let rawJson: unknown;
  try {
    rawJson = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  if (typeof rawJson !== "object" || rawJson === null || Array.isArray(rawJson)) {
    return NextResponse.json({ error: "Expected JSON object body." }, { status: 400 });
  }

  const body = rawJson as TriagePostBody;
  const payloadText = typeof body.payloadText === "string" ? body.payloadText.trim() : "";
  if (!payloadText || payloadText.length > 4000) {
    return NextResponse.json(
      { error: "payloadText must be a non-empty string under 4000 characters." },
      { status: 400 },
    );
  }

  const idempotencyKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey.trim().length > 0
      ? body.idempotencyKey.trim().slice(0, 128)
      : `evt-${Date.now()}`;
  const service =
    typeof body.service === "string" && /^[a-z0-9-]{1,64}$/.test(body.service.trim())
      ? body.service.trim()
      : undefined;
  const p95Ms =
    typeof body.p95Ms === "number" && Number.isFinite(body.p95Ms) && body.p95Ms >= 0
      ? Math.min(120_000, body.p95Ms)
      : undefined;

  const requestedMode = parseMode(body.mode);
  const fault = parseFault(body.fault);
  const secret = resolveDemoSigningSecret();
  const liveApiKey = process.env.GEMINI_API_KEY?.trim() || "";
  const liveAiConfigured = liveApiKey.length > 0;

  const nowSec = Math.floor(Date.now() / 1000);
  const signedTimestamp = fault === "stale_timestamp" ? nowSec - 600 : nowSec;
  const canonicalPayload = JSON.stringify({
    service: service ?? null,
    p95Ms: p95Ms ?? null,
    payloadText,
    idempotencyKey,
  });
  const signature = signWebhookPayload(secret, signedTimestamp, canonicalPayload);
  const wireBody =
    fault === "tamper_body"
      ? JSON.stringify({
          service: service ?? null,
          p95Ms: p95Ms ?? null,
          payloadText: `${payloadText} [TAMPERED_IN_TRANSIT]`,
          idempotencyKey,
        })
      : canonicalPayload;

  const requestEnvelope = {
    headers: {
      "Content-Type": "application/json",
      "X-AgentGate-Source": "workbench",
      "X-AgentGate-Timestamp": String(signedTimestamp),
      "X-AgentGate-Idempotency-Key": idempotencyKey,
      "X-AgentGate-Signature": signature,
    },
    rawBody: canonicalPayload,
    wireBody,
  };

  const cookieStore = await cookies();
  const memMap = getDemoIdempotencyMap();
  const cookieKeys = parseSignedLedgerCookie(
    cookieStore.get(LEDGER_COOKIE_NAME)?.value,
    secret,
    nowSec,
  );

  // Stage 1 & 2 mirror agentgate.webhook.ingest_webhook exact security ordering.
  const tReplayStart = performance.now();
  const ageSeconds = Math.abs(nowSec - signedTimestamp);
  const replayOk = ageSeconds <= MAX_AGE_SECONDS;
  const replayCheckMs = Math.max(0.05, Number((performance.now() - tReplayStart).toFixed(2)));

  if (!replayOk) {
    const stages: PipelineStageResult[] = [
      {
        id: "hmac",
        label: "HMAC-SHA256 Raw-Body Verify",
        status: "skipped",
        detail: "Skipped after replay-window failure to block stale deliveries fast.",
        durationMs: 0,
      },
      {
        id: "idempotency",
        label: "Replay Window & Idempotency",
        status: "failed",
        detail: `Timestamp skew (${ageSeconds}s) exceeds ${MAX_AGE_SECONDS}s window.`,
        durationMs: replayCheckMs,
      },
      {
        id: "mcp",
        label: "MCP Diagnostic Tools",
        status: "skipped",
        detail: "Not executed because webhook envelope was rejected (401).",
        durationMs: 0,
      },
      {
        id: "verdict",
        label: "Structured Verdict & Injection Guard",
        status: "skipped",
        detail: "No agent invocation billed on unauthenticated requests.",
        durationMs: 0,
      },
    ];

    const resPayload: TriageApiResponse = {
      httpStatus: 401,
      webhookStatus: "rejected_stale",
      reason: `Timestamp skew exceeds ${MAX_AGE_SECONDS}s replay window.`,
      requestEnvelope,
      stages,
      toolTraces: [],
      baselineOutput: null,
      mcpOutput: null,
      injectionDetected: false,
      injectionBlocked: true,
      engineUsed: null,
      fallbackNotice: null,
      totalLatencyMs: Number((performance.now() - startedAt).toFixed(2)),
      claimedKeyCount: Object.keys(cookieKeys).length,
      liveAiConfigured,
    };
    return NextResponse.json(resPayload, { status: 401 });
  }

  const tHmacStart = performance.now();
  const sigValid = verifyWebhookSignature(secret, signedTimestamp, wireBody, signature);
  const hmacMs = Math.max(0.05, Number((performance.now() - tHmacStart).toFixed(2)));

  if (!sigValid) {
    const stages: PipelineStageResult[] = [
      {
        id: "hmac",
        label: "HMAC-SHA256 Raw-Body Verify",
        status: "failed",
        detail: "timingSafeEqual mismatch — wire body hash did not match v1 signature.",
        durationMs: hmacMs,
      },
      {
        id: "idempotency",
        label: "Replay Window & Idempotency",
        status: "skipped",
        detail: "Idempotency key left unclaimed after invalid signature.",
        durationMs: 0,
      },
      {
        id: "mcp",
        label: "MCP Diagnostic Tools",
        status: "skipped",
        detail: "Not executed because signature verification failed (401).",
        durationMs: 0,
      },
      {
        id: "verdict",
        label: "Structured Verdict & Injection Guard",
        status: "skipped",
        detail: "Protected downstream triage loop from unverified payload.",
        durationMs: 0,
      },
    ];

    const resPayload: TriageApiResponse = {
      httpStatus: 401,
      webhookStatus: "rejected_signature",
      reason: "Invalid or tampered HMAC-SHA256 raw-body signature.",
      requestEnvelope,
      stages,
      toolTraces: [],
      baselineOutput: null,
      mcpOutput: null,
      injectionDetected: false,
      injectionBlocked: true,
      engineUsed: null,
      fallbackNotice: null,
      totalLatencyMs: Number((performance.now() - startedAt).toFixed(2)),
      claimedKeyCount: Object.keys(cookieKeys).length,
      liveAiConfigured,
    };
    return NextResponse.json(resPayload, { status: 401 });
  }

  const tClaimStart = performance.now();
  const claim = claimIdempotencyKey(idempotencyKey, memMap, cookieKeys, nowSec, TTL_SECONDS);
  const claimMs = Math.max(0.05, Number((performance.now() - tClaimStart).toFixed(2)));
  const signedCookie = serializeSignedLedgerCookie(claim.updatedCookieKeys, secret);

  if (!claim.claimed) {
    const stages: PipelineStageResult[] = [
      {
        id: "hmac",
        label: "HMAC-SHA256 Raw-Body Verify",
        status: "passed",
        detail: `Verified v1 signature on ${wireBody.length}-byte raw payload (age ${ageSeconds}s).`,
        durationMs: hmacMs,
      },
      {
        id: "idempotency",
        label: "Replay Window & Idempotency",
        status: "passed",
        detail: `Duplicate key '${idempotencyKey}' detected; claim denied without re-running agent.`,
        durationMs: claimMs,
      },
      {
        id: "mcp",
        label: "MCP Diagnostic Tools",
        status: "skipped",
        detail: "Skipped duplicate webhook execution (zero duplicate LLM/MCP calls).",
        durationMs: 0,
      },
      {
        id: "verdict",
        label: "Structured Verdict & Injection Guard",
        status: "skipped",
        detail: "Idempotency guarantee prevented duplicate alert fan-out.",
        durationMs: 0,
      },
    ];

    const resPayload: TriageApiResponse = {
      httpStatus: 200,
      webhookStatus: "duplicate",
      reason: `Idempotency key '${idempotencyKey}' already claimed; duplicate delivery skipped.`,
      requestEnvelope,
      stages,
      toolTraces: [],
      baselineOutput: null,
      mcpOutput: null,
      injectionDetected: false,
      injectionBlocked: true,
      engineUsed: null,
      fallbackNotice: null,
      totalLatencyMs: Number((performance.now() - startedAt).toFixed(2)),
      claimedKeyCount: Object.keys(claim.updatedCookieKeys).length,
      liveAiConfigured,
    };

    const res = NextResponse.json(resPayload, { status: 200 });
    res.cookies.set(LEDGER_COOKIE_NAME, signedCookie, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: TTL_SECONDS,
    });
    return res;
  }

  // Stage 3 & 4: Authenticated unique webhook — execute baseline vs. MCP triage.
  const baselineOutput = runBaselineHeuristic(payloadText);
  const tAgentStart = performance.now();
  let executionResult;

  if (requestedMode === "live_ai") {
    if (!liveAiConfigured) {
      const det = runDeterministicMcpTriage(payloadText, service, p95Ms);
      executionResult = {
        ...det,
        fallbackUsed: true,
        fallbackReason:
          "Live AI secret is not configured in this environment — ran deterministic MCP engine.",
      };
    } else {
      const headerStore = await headers();
      const forwardedFor = headerStore.get("x-forwarded-for");
      const clientIp =
        forwardedFor?.split(",")[0]?.trim() ||
        headerStore.get("x-real-ip")?.trim() ||
        "local";
      const rateLimit = checkLiveAiRateLimit(getDemoLiveRateMap(), clientIp, Date.now(), 5, 60_000);
      if (!rateLimit.allowed) {
        const det = runDeterministicMcpTriage(payloadText, service, p95Ms);
        executionResult = {
          ...det,
          fallbackUsed: true,
          fallbackReason: `Live AI quota guard (5 req/min/IP) active for ${rateLimit.retryAfterSeconds}s — fell back to deterministic MCP.`,
        };
      } else {
        executionResult = await runGeminiMcpTriage(payloadText, liveApiKey, service, p95Ms);
      }
    }
  } else {
    executionResult = runDeterministicMcpTriage(payloadText, service, p95Ms);
  }

  const agentMs = Math.max(0.1, Number((performance.now() - tAgentStart).toFixed(2)));
  const mcpToolDurationSum = executionResult.toolTraces.reduce(
    (sum, trace) => sum + trace.durationMs,
    0,
  );

  const stages: PipelineStageResult[] = [
    {
      id: "hmac",
      label: "HMAC-SHA256 Raw-Body Verify",
      status: "passed",
      detail: `Verified v1 signature on ${wireBody.length}-byte raw payload (age ${ageSeconds}s).`,
      durationMs: hmacMs,
    },
    {
      id: "idempotency",
      label: "Replay Window & Idempotency",
      status: "passed",
      detail: `Claimed unique key '${idempotencyKey}' into TTL + signed session ledger.`,
      durationMs: claimMs,
    },
    {
      id: "mcp",
      label: "MCP Diagnostic Tools",
      status: "passed",
      detail: `${executionResult.toolTraces.length} read-only tool call(s) (${executionResult.engineUsed === "live_ai" ? "Live AI + MCP" : "Instant MCP"}).`,
      durationMs:
        executionResult.engineUsed === "live_ai"
          ? agentMs
          : Number(mcpToolDurationSum.toFixed(2)),
    },
    {
      id: "verdict",
      label: "Structured Verdict & Injection Guard",
      status: "passed",
      detail: executionResult.injectionDetected
        ? `Adversarial override neutralized; severity=${executionResult.verdict.severity}, runbook=${executionResult.verdict.recommendedRunbook ?? "null"}.`
        : `Schema-valid JSON output; severity=${executionResult.verdict.severity}, runbook=${executionResult.verdict.recommendedRunbook ?? "null"}.`,
      durationMs: executionResult.engineUsed === "live_ai" ? 0.1 : agentMs,
    },
  ];

  const resPayload: TriageApiResponse = {
    httpStatus: 200,
    webhookStatus: "accepted",
    reason: "Webhook authenticated and idempotency key claimed.",
    requestEnvelope,
    stages,
    toolTraces: executionResult.toolTraces,
    baselineOutput,
    mcpOutput: executionResult.verdict,
    injectionDetected: executionResult.injectionDetected,
    injectionBlocked: executionResult.injectionBlocked,
    engineUsed: executionResult.engineUsed,
    fallbackNotice: executionResult.fallbackUsed ? executionResult.fallbackReason : null,
    totalLatencyMs: Number((performance.now() - startedAt).toFixed(2)),
    claimedKeyCount: Object.keys(claim.updatedCookieKeys).length,
    liveAiConfigured,
  };

  const res = NextResponse.json(resPayload, { status: 200 });
  res.cookies.set(LEDGER_COOKIE_NAME, signedCookie, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: TTL_SECONDS,
  });
  return res;
}
