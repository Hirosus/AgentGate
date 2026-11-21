import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import {
  checkLiveAiRateLimit,
  claimIdempotencyKey,
  extractClientIp,
  getDemoLiveRateMap,
  isSameOriginRequest,
  LEDGER_COOKIE_NAME,
  parseSignedLedgerCookie,
  resolveDemoSigningSecret,
  resolveWebhookMaxAgeSeconds,
  runBaselineHeuristic,
  runDeterministicMcpTriage,
  runGeminiMcpTriage,
  serializeSignedLedgerCookie,
  SERVICE_NAME_RE,
  signWebhookPayload,
  verifyWebhookSignature,
  type EngineMode,
  type FaultMode,
  type PipelineStageResult,
  type TriageApiResponse,
} from "@/lib/triageEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TTL_SECONDS = 86_400;

const LEDGER_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/api/triage",
  maxAge: TTL_SECONDS,
};

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

  return NextResponse.json({
    liveAiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
    claimedKeyCount: cookieKeys.size,
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const startedAt = performance.now();

  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Cross-origin request forbidden." }, { status: 403 });
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    return NextResponse.json(
      { error: "Unsupported Media Type: Content-Type must include application/json." },
      { status: 415 },
    );
  }

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
    typeof body.service === "string" && SERVICE_NAME_RE.test(body.service.trim())
      ? body.service.trim()
      : undefined;
  const p95Ms =
    typeof body.p95Ms === "number" && Number.isFinite(body.p95Ms) && body.p95Ms >= 0
      ? Math.min(120_000, body.p95Ms)
      : undefined;

  const requestedMode = parseMode(body.mode);
  const fault = parseFault(body.fault);
  const secret = resolveDemoSigningSecret();
  const maxAgeSeconds = resolveWebhookMaxAgeSeconds();
  const liveApiKey = process.env.GEMINI_API_KEY?.trim() || "";
  const liveAiConfigured = liveApiKey.length > 0;

  const nowSec = Math.floor(Date.now() / 1000);
  const signedTimestamp =
    fault === "stale_timestamp" ? nowSec - Math.max(600, maxAgeSeconds + 300) : nowSec;
  const canonicalPayload = JSON.stringify({
    service: service ?? null,
    p95Ms: p95Ms ?? null,
    payloadText,
    idempotencyKey,
  });
  const signature = signWebhookPayload(secret, signedTimestamp, idempotencyKey, canonicalPayload);
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
  const cookieKeys = parseSignedLedgerCookie(
    cookieStore.get(LEDGER_COOKIE_NAME)?.value,
    secret,
    nowSec,
  );

  const stageLabelReplay = `Replay Window (${maxAgeSeconds}s)`;
  const stageLabelHmac = "HMAC-SHA256 v2 Signature";
  const stageLabelIdempotency = "Idempotency Ledger";
  const stageLabelMcp = "MCP Diagnostic Tools";
  const stageLabelVerdict = "Structured Verdict & Injection Guard";

  // Stage 1: Replay window check (mirrors agentgate.webhook.ingest_webhook).
  const tReplayStart = performance.now();
  const ageSeconds = Math.abs(nowSec - signedTimestamp);
  const replayOk = ageSeconds <= maxAgeSeconds;
  const replayCheckMs = Math.max(0.05, Number((performance.now() - tReplayStart).toFixed(2)));

  if (!replayOk) {
    const stages: PipelineStageResult[] = [
      {
        id: "replay",
        label: stageLabelReplay,
        status: "failed",
        detail: `Timestamp skew (${ageSeconds}s) exceeds ${maxAgeSeconds}s window.`,
        durationMs: replayCheckMs,
      },
      {
        id: "hmac",
        label: stageLabelHmac,
        status: "skipped",
        detail: "Skipped after replay-window failure to block stale deliveries fast.",
        durationMs: 0,
      },
      {
        id: "idempotency",
        label: stageLabelIdempotency,
        status: "skipped",
        detail: "Idempotency key left unclaimed after replay-window rejection.",
        durationMs: 0,
      },
      {
        id: "mcp",
        label: stageLabelMcp,
        status: "skipped",
        detail: "Not executed because webhook envelope was rejected (401).",
        durationMs: 0,
      },
      {
        id: "verdict",
        label: stageLabelVerdict,
        status: "skipped",
        detail: "No agent invocation billed on unauthenticated requests.",
        durationMs: 0,
      },
    ];

    const resPayload: TriageApiResponse = {
      httpStatus: 401,
      webhookStatus: "rejected_stale",
      reason: `Timestamp skew exceeds ${maxAgeSeconds}s replay window.`,
      requestEnvelope,
      stages,
      toolTraces: [],
      baselineOutput: null,
      mcpOutput: null,
      injectionDetected: false,
      injectionBlocked: null,
      engineUsed: null,
      fallbackNotice: null,
      totalLatencyMs: Number((performance.now() - startedAt).toFixed(2)),
      claimedKeyCount: cookieKeys.size,
      liveAiConfigured,
    };
    return NextResponse.json(resPayload, { status: 401 });
  }

  // Stage 2: Cryptographic v2 HMAC verification.
  const tHmacStart = performance.now();
  const sigValid = verifyWebhookSignature(
    secret,
    signedTimestamp,
    idempotencyKey,
    wireBody,
    signature,
  );
  const hmacMs = Math.max(0.05, Number((performance.now() - tHmacStart).toFixed(2)));

  if (!sigValid) {
    const stages: PipelineStageResult[] = [
      {
        id: "replay",
        label: stageLabelReplay,
        status: "passed",
        detail: `Timestamp within ${maxAgeSeconds}s replay window (age ${ageSeconds}s).`,
        durationMs: replayCheckMs,
      },
      {
        id: "hmac",
        label: stageLabelHmac,
        status: "failed",
        detail: "timingSafeEqual mismatch — wire body or key binding did not match v2 signature.",
        durationMs: hmacMs,
      },
      {
        id: "idempotency",
        label: stageLabelIdempotency,
        status: "skipped",
        detail: "Idempotency key left unclaimed after invalid signature.",
        durationMs: 0,
      },
      {
        id: "mcp",
        label: stageLabelMcp,
        status: "skipped",
        detail: "Not executed because signature verification failed (401).",
        durationMs: 0,
      },
      {
        id: "verdict",
        label: stageLabelVerdict,
        status: "skipped",
        detail: "Protected downstream triage loop from unverified payload.",
        durationMs: 0,
      },
    ];

    const resPayload: TriageApiResponse = {
      httpStatus: 401,
      webhookStatus: "rejected_signature",
      reason: "Invalid or tampered HMAC-SHA256 v2 webhook signature.",
      requestEnvelope,
      stages,
      toolTraces: [],
      baselineOutput: null,
      mcpOutput: null,
      injectionDetected: false,
      injectionBlocked: null,
      engineUsed: null,
      fallbackNotice: null,
      totalLatencyMs: Number((performance.now() - startedAt).toFixed(2)),
      claimedKeyCount: cookieKeys.size,
      liveAiConfigured,
    };
    return NextResponse.json(resPayload, { status: 401 });
  }

  // Stage 3: Per-session signed cookie idempotency ledger.
  const tClaimStart = performance.now();
  if (fault === "duplicate_replay" && !cookieKeys.has(idempotencyKey)) {
    cookieKeys.set(idempotencyKey, nowSec + TTL_SECONDS);
  }
  const claim = claimIdempotencyKey(idempotencyKey, null, cookieKeys, nowSec, TTL_SECONDS);
  const claimMs = Math.max(0.05, Number((performance.now() - tClaimStart).toFixed(2)));
  const signedCookie = serializeSignedLedgerCookie(claim.updatedCookieKeys, secret);
  const persistedKeyCount = parseSignedLedgerCookie(signedCookie, secret, nowSec).size;

  if (!claim.claimed) {
    const stages: PipelineStageResult[] = [
      {
        id: "replay",
        label: stageLabelReplay,
        status: "passed",
        detail: `Timestamp within ${maxAgeSeconds}s replay window (age ${ageSeconds}s).`,
        durationMs: replayCheckMs,
      },
      {
        id: "hmac",
        label: stageLabelHmac,
        status: "passed",
        detail: `Verified v2 signature on ${wireBody.length}-byte raw payload bound to '${idempotencyKey}'.`,
        durationMs: hmacMs,
      },
      {
        id: "idempotency",
        label: stageLabelIdempotency,
        status: "passed",
        detail: `Duplicate key '${idempotencyKey}' detected; claim denied without re-running agent.`,
        durationMs: claimMs,
      },
      {
        id: "mcp",
        label: stageLabelMcp,
        status: "skipped",
        detail: "Skipped duplicate webhook execution (zero duplicate LLM/MCP calls).",
        durationMs: 0,
      },
      {
        id: "verdict",
        label: stageLabelVerdict,
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
      injectionBlocked: null,
      engineUsed: null,
      fallbackNotice: null,
      totalLatencyMs: Number((performance.now() - startedAt).toFixed(2)),
      claimedKeyCount: persistedKeyCount,
      liveAiConfigured,
    };

    const res = NextResponse.json(resPayload, { status: 200 });
    res.cookies.set(LEDGER_COOKIE_NAME, signedCookie, LEDGER_COOKIE_OPTIONS);
    return res;
  }

  // Stage 4 & 5: Authenticated unique webhook — execute baseline vs. MCP triage.
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
      const clientIp = extractClientIp(headerStore);
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

  const agentMs = Math.max(0.05, Number((performance.now() - tAgentStart).toFixed(2)));
  const mcpToolDurationSum = executionResult.toolTraces.reduce(
    (sum, trace) => sum + trace.durationMs,
    0,
  );
  const mcpStageDuration = Number(mcpToolDurationSum.toFixed(2));
  const verdictStageDuration = Math.max(0.05, Number((agentMs - mcpToolDurationSum).toFixed(2)));

  const stages: PipelineStageResult[] = [
    {
      id: "replay",
      label: stageLabelReplay,
      status: "passed",
      detail: `Timestamp within ${maxAgeSeconds}s replay window (age ${ageSeconds}s).`,
      durationMs: replayCheckMs,
    },
    {
      id: "hmac",
      label: stageLabelHmac,
      status: "passed",
      detail: `Verified v2 signature on ${wireBody.length}-byte raw payload bound to '${idempotencyKey}'.`,
      durationMs: hmacMs,
    },
    {
      id: "idempotency",
      label: stageLabelIdempotency,
      status: "passed",
      detail: `Claimed unique key '${idempotencyKey}' into signed per-session cookie ledger.`,
      durationMs: claimMs,
    },
    {
      id: "mcp",
      label: stageLabelMcp,
      status: "passed",
      detail: `${executionResult.toolTraces.length} read-only tool call(s) (${executionResult.engineUsed === "live_ai" ? "Live AI + MCP" : "Instant MCP"}).`,
      durationMs: mcpStageDuration,
    },
    {
      id: "verdict",
      label: stageLabelVerdict,
      status: "passed",
      detail: executionResult.injectionDetected
        ? `Adversarial override neutralized; severity=${executionResult.verdict.severity}, runbook=${executionResult.verdict.recommendedRunbook ?? "null"}.`
        : `Schema-valid JSON output; severity=${executionResult.verdict.severity}, runbook=${executionResult.verdict.recommendedRunbook ?? "null"}.`,
      durationMs: verdictStageDuration,
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
    claimedKeyCount: persistedKeyCount,
    liveAiConfigured,
  };

  const res = NextResponse.json(resPayload, { status: 200 });
  res.cookies.set(LEDGER_COOKIE_NAME, signedCookie, LEDGER_COOKIE_OPTIONS);
  return res;
}
