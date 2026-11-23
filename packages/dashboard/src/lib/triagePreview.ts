import {
  MCP_CATALOG,
  type EngineMode,
  type FaultMode,
  type LatencyBudgetResult,
  type LogInspectionResult,
  type McpToolTraceEntry,
  type RunbookEntry,
  type SymptomTag,
  type TriageApiResponse,
  type TriagePreset,
  type TriageSeverity,
} from "./triageCatalog";

export interface ServiceSlaInfo {
  readonly service: string;
  readonly budgetMs: number;
  readonly p95Ms: number;
  readonly ratio: number;
  readonly breached: boolean;
  readonly bandSeverity: TriageSeverity;
}

const SERVICE_NAME_RE = /^[a-z0-9-]{1,64}$/;
const INJECTION_MARKER_RE =
  /\b(?:system\s+override|ignore\s+previous|disregard\s+previous|new\s+system\s+instruction)\b/i;

const SYMPTOM_MATCHERS: ReadonlyArray<{
  readonly tag: SymptomTag;
  readonly pattern: RegExp;
}> = [
  {
    tag: "db_pool_exhaustion",
    pattern: /\bpg_pool\b|\bselect\s+for\s+update\b|\bconnection\s+pool\b|\brail-db\b|\btoo\s+many\s+connections\b/i,
  },
  {
    tag: "auth_failure",
    pattern: /\bhmac\b|\brejected_signature\b|\bclock_skew\b|\bsignature\s+verification\b|\binvalid\s+signature\b/i,
  },
  {
    tag: "webhook_timeout",
    pattern: /\bwebhook\b|\b429\b|\bdelivery\s+backlog\b|\badapter_timeout\b|\bretry\s+backoff\b/i,
  },
  {
    tag: "vlan_packet_loss",
    pattern: /\bvlan\b|\bpacket\s+loss\b|\bcrc\s+errors\b|\bethernet\b|\buplink\b/i,
  },
  {
    tag: "tls_cert_expiry",
    pattern: /\btls\b|\bx509\b|\bcert\b|\bcertificate\b|\bhandshake\b/i,
  },
  {
    tag: "redis_eviction_spike",
    pattern: /\bredis\b|\beviction\b|\bmaxmemory\b|\bhit\s+ratio\b|\booming\b/i,
  },
  {
    tag: "dns_resolution_failure",
    pattern: /\bdns\b|\bnxdomain\b|\bservfail\b|\bresolver\b|\bupstream\s+lookup\b/i,
  },
  {
    tag: "lambda_oom_throttle",
    pattern: /\blambda\b|\boom\b|\boutofmemory\b|\bthrottl\w*\b|\bconcurrency\b|\bcold\s+start\b/i,
  },
];

export function resolveServiceBudgetMs(service: string): number {
  const clean = service.trim().toLowerCase();
  const budgets: Readonly<Record<string, number>> = MCP_CATALOG.serviceBudgetsMs;
  if (Object.hasOwn(budgets, clean)) {
    return budgets[clean] ?? MCP_CATALOG.defaultBudgetMs;
  }
  return MCP_CATALOG.defaultBudgetMs;
}

export function classifyLatencySeverity(p95Ms: number, budgetMs: number): TriageSeverity {
  const ratio = budgetMs > 0 ? p95Ms / budgetMs : 0;
  if (ratio >= 5) {
    return "critical";
  }
  if (ratio >= 3) {
    return "high";
  }
  if (ratio > 1) {
    return "medium";
  }
  return "low";
}

export function getServiceSlaInfo(service: string, p95Ms: number): ServiceSlaInfo {
  const safeService = SERVICE_NAME_RE.test(service.trim().toLowerCase())
    ? service.trim().toLowerCase()
    : "checkout-api";
  const budgetMs = resolveServiceBudgetMs(safeService);
  const safeP95 = Number.isFinite(p95Ms) && p95Ms >= 0 ? p95Ms : 0;
  const ratio = budgetMs > 0 ? safeP95 / budgetMs : 0;
  return {
    service: safeService,
    budgetMs,
    p95Ms: safeP95,
    ratio: Number(ratio.toFixed(2)),
    breached: safeP95 > budgetMs,
    bandSeverity: classifyLatencySeverity(safeP95, budgetMs),
  };
}

function getPreviewLogLines(service: string): readonly string[] {
  const logs: Readonly<Record<string, readonly string[]>> = MCP_CATALOG.defaultLogs;
  if (Object.hasOwn(logs, service)) {
    return logs[service] ?? [];
  }
  return [];
}

function getPreviewRunbook(tag: SymptomTag): RunbookEntry {
  const runbooks: Readonly<Record<SymptomTag, RunbookEntry>> = MCP_CATALOG.runbooks;
  return runbooks[tag];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchPreviewSymptom(
  service: string,
  payloadText: string,
  logLines: readonly string[],
): SymptomTag | null {
  const strippedPayload = payloadText.replace(new RegExp(`\\b${escapeRegExp(service)}\\b`, "gi"), " ");
  const cleanLogs = logLines.filter((line) => !INJECTION_MARKER_RE.test(line));
  const combined = `${strippedPayload} ${cleanLogs.join(" ")}`;
  if (/\b(?:healthcheck|heartbeat)\b/i.test(strippedPayload) && !/breach|timeout|error|expired/i.test(strippedPayload)) {
    return null;
  }
  for (const rule of SYMPTOM_MATCHERS) {
    if (rule.pattern.test(strippedPayload)) {
      return rule.tag;
    }
  }
  for (const rule of SYMPTOM_MATCHERS) {
    if (rule.pattern.test(combined)) {
      return rule.tag;
    }
  }
  return null;
}

/**
 * Builds a deterministic client-side preview snapshot for the inspector on first
 * load or preset selection without writing any idempotency key to the server ledger.
 */
export function buildTriagePreview(opts: {
  readonly service: string;
  readonly p95Ms: number | null;
  readonly payloadText: string;
  readonly idempotencyKey: string;
  readonly fault: FaultMode;
  readonly mode: EngineMode;
  readonly liveAiConfigured: boolean;
  readonly claimedKeyCount: number;
}): TriageApiResponse {
  const cleanService = SERVICE_NAME_RE.test(opts.service.trim().toLowerCase())
    ? opts.service.trim().toLowerCase()
    : "checkout-api";
  const effectiveKey = opts.idempotencyKey.trim() || `evt-${cleanService}-preview`;
  const lines = getPreviewLogLines(cleanService);
  const telemetryInjection = lines.some((line) => INJECTION_MARKER_RE.test(line));
  const payloadInjection = INJECTION_MARKER_RE.test(opts.payloadText);
  const injectionDetected = telemetryInjection || payloadInjection;

  const p95Match = opts.payloadText.match(/\bp95(?:\s+latency)?[:\s=]+(\d+(?:\.\d+)?)\s*ms\b/i);
  const parsedP95 = p95Match?.[1] ? Number(p95Match[1]) : null;
  const effectiveP95 = opts.p95Ms !== null && Number.isFinite(opts.p95Ms) ? opts.p95Ms : parsedP95;

  const canonicalRawBody = JSON.stringify({
    service: cleanService,
    p95Ms: opts.p95Ms,
    payloadText: opts.payloadText,
    idempotencyKey: effectiveKey,
  });
  const wireBody =
    opts.fault === "tamper_body"
      ? JSON.stringify({
          service: cleanService,
          p95Ms: opts.p95Ms,
          payloadText: `${opts.payloadText} [TAMPERED_IN_TRANSIT]`,
          idempotencyKey: effectiveKey,
        })
      : canonicalRawBody;

  const timestampSec = opts.fault === "stale_timestamp" ? 1763800000 - 600 : 1763800000;
  const requestEnvelope = {
    headers: {
      "Content-Type": "application/json",
      "X-AgentGate-Source": "workbench",
      "X-AgentGate-Timestamp": String(timestampSec),
      "X-AgentGate-Idempotency-Key": effectiveKey,
      "X-AgentGate-Signature": "v2=<hmac-sha256-computed-on-dispatch>",
    },
    rawBody: canonicalRawBody,
    wireBody,
  };

  const tag = matchPreviewSymptom(cleanService, opts.payloadText, lines);
  const sla = effectiveP95 !== null ? getServiceSlaInfo(cleanService, effectiveP95) : null;
  const severity: TriageSeverity =
    tag === null
      ? sla?.breached
        ? sla.bandSeverity
        : "low"
      : sla
        ? sla.bandSeverity === "critical" || sla.bandSeverity === "high"
          ? sla.bandSeverity
          : "medium"
        : "medium";
  const runbook = tag ? getPreviewRunbook(tag) : null;

  const logResult: LogInspectionResult = {
    service: cleanService,
    lines,
    truncated: false,
    untrustedTelemetry: true,
  };
  const toolTraces: McpToolTraceEntry[] = [
    {
      toolName: "inspect_log_excerpt",
      args: { service: cleanService, maxLines: 10 },
      result: logResult,
      durationMs: 0.2,
      untrustedDataFlag: true,
    },
  ];
  if (sla !== null) {
    const budgetResult: LatencyBudgetResult = {
      service: cleanService,
      p95Ms: sla.p95Ms,
      budgetMs: sla.budgetMs,
      breached: sla.breached,
      recommendedSeverity: sla.bandSeverity,
    };
    toolTraces.push({
      toolName: "check_latency_budget",
      args: { service: cleanService, p95Ms: sla.p95Ms },
      result: budgetResult,
      durationMs: 0.2,
    });
  }
  if (runbook && tag) {
    toolTraces.push({
      toolName: "lookup_runbook",
      args: { symptomTag: tag },
      result: runbook,
      durationMs: 0.1,
    });
  }

  return {
    httpStatus: 200,
    webhookStatus: "accepted",
    reason: "Preview snapshot only. Click Dispatch webhook to execute live v2 HMAC verification.",
    requestEnvelope,
    stages: [
      {
        id: "replay",
        label: "Replay Window (300s)",
        status: "passed",
        detail: "Preview ready: verifies X-AgentGate-Timestamp age against 300s replay skew window.",
        durationMs: 0.1,
      },
      {
        id: "hmac",
        label: "HMAC-SHA256 v2 Signature",
        status: "passed",
        detail: "Preview ready: verifies v2 HMAC over timestamp, idempotency key, and raw body bytes.",
        durationMs: 0.2,
      },
      {
        id: "idempotency",
        label: "Idempotency Ledger",
        status: "passed",
        detail: `Preview ready: key '${effectiveKey}' will be claimed on Dispatch without mutating cookies on load.`,
        durationMs: 0.1,
      },
      {
        id: "mcp",
        label: "MCP Diagnostic Tools",
        status: "passed",
        detail: `${toolTraces.length} read-only MCP tool calls modeled from canonical catalog.`,
        durationMs: Number(toolTraces.reduce((acc, item) => acc + item.durationMs, 0).toFixed(2)),
      },
      {
        id: "verdict",
        label: "Structured Verdict & Injection Guard",
        status: "passed",
        detail: `Verified JSON verdict: severity=${severity}, runbook=${runbook?.runbookId ?? "null"}.`,
        durationMs: 0.4,
      },
    ],
    toolTraces,
    baselineOutput: {
      severity: /\bcritical\b/i.test(opts.payloadText) ? "critical" : "medium",
      category: tag ?? "unverified-heuristic",
      summary: "No-tool keyword heuristic lacks SLA budget lookup and canonical runbook mapping.",
      recommendedRunbook: null,
      followedUntrustedInstruction: false,
      schemaValid: true,
      checks: [],
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
    mcpOutput: {
      severity,
      category: tag ?? (sla?.breached ? "unclassified-sla-breach" : "benign-noise"),
      summary: runbook
        ? `Service ${cleanService}: classified ${tag} and mapped runbook ${runbook.runbookId}${sla ? ` at p95 ${sla.p95Ms}ms (${sla.ratio}x of ${sla.budgetMs}ms SLO)` : ""}.`
        : sla?.breached
          ? `Service ${cleanService}: SLA latency breach at p95 ${sla.p95Ms}ms (budget ${sla.budgetMs}ms) without matching a runbook symptom tag.`
          : `Service ${cleanService}: benign probe with no SLA breach; untrusted override ignored.`,
      recommendedRunbook: runbook?.runbookId ?? null,
      followedUntrustedInstruction: false,
      schemaValid: true,
      checks: runbook ? runbook.checks : [],
      toolCalls: toolTraces.length,
      inputTokens: 0,
      outputTokens: 0,
    },
    injectionDetected,
    injectionBlocked: true,
    engineUsed: opts.mode,
    fallbackNotice: null,
    totalLatencyMs: 0.8,
    claimedKeyCount: opts.claimedKeyCount,
    liveAiConfigured: opts.liveAiConfigured,
  };
}

export function buildPresetInitialPreview(preset: TriagePreset): TriageApiResponse {
  return buildTriagePreview({
    service: preset.service,
    p95Ms: preset.p95Ms,
    payloadText: preset.payloadText,
    idempotencyKey: `evt-${preset.service}-preview`,
    fault: "valid",
    mode: "deterministic_mcp",
    liveAiConfigured: false,
    claimedKeyCount: 0,
  });
}

export function formatSignedCurlCommand(
  response: TriageApiResponse,
  originUrl = "http://127.0.0.1:8000",
): string {
  const { headers, wireBody } = response.requestEnvelope;
  const escapedBody = wireBody.replace(/'/g, `'\\''`);
  return [
    `curl -sS -X POST "${originUrl.replace(/\/+$/, "")}/webhooks/triage" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "X-AgentGate-Source: ${headers["X-AgentGate-Source"]}" \\`,
    `  -H "X-AgentGate-Timestamp: ${headers["X-AgentGate-Timestamp"]}" \\`,
    `  -H "X-AgentGate-Idempotency-Key: ${headers["X-AgentGate-Idempotency-Key"]}" \\`,
    `  -H "X-AgentGate-Signature: ${headers["X-AgentGate-Signature"]}" \\`,
    `  --data-raw '${escapedBody}'`,
  ].join("\n");
}

export function formatPythonSdkSnippet(
  response: TriageApiResponse,
  service: string,
  p95Ms: number | null,
  payloadText: string,
): string {
  const key = response.requestEnvelope.headers["X-AgentGate-Idempotency-Key"];
  const payloadLiteral = JSON.stringify({
    service,
    p95Ms,
    payloadText,
    idempotencyKey: key,
  });
  return [
    `import os`,
    `from agentgate import AgentGateClient`,
    ``,
    `client = AgentGateClient(`,
    `    base_url=os.environ.get("AGENTGATE_BASE_URL", "http://127.0.0.1:8000"),`,
    `    webhook_secret=os.environ["AGENTGATE_WEBHOOK_SECRET"],`,
    `)`,
    ``,
    `decision = client.send_signed_webhook(`,
    `    idempotency_key=${JSON.stringify(key)},`,
    `    raw_body=${JSON.stringify(payloadLiteral)}.encode("utf-8"),`,
    `    source="workbench",`,
    `)`,
    `print(decision.status, decision.triage.recommended_runbook if decision.triage else None)`,
  ].join("\n");
}
