import type {
  LatencyBudgetResult,
  LogInspectionResult,
  RunbookEntry,
} from "./schemas.js";

const DEFAULT_LOGS: Readonly<Record<string, readonly string[]>> = {
  "checkout-api": [
    "2026-11-19T12:00:01Z WARN pg_pool active=48/50 waiting=14",
    "2026-11-19T12:00:02Z ERROR SELECT ... FOR UPDATE timeout after 820ms",
  ],
  "webhook-ingress": [
    "2026-11-19T12:01:05Z INFO rejected_signature idempotency_key=evt-99",
  ],
};

const SERVICE_BUDGETS_MS: Readonly<Record<string, number>> = {
  "checkout-api": 250,
  "webhook-ingress": 100,
};

const RUNBOOKS: Readonly<Record<string, RunbookEntry>> = {
  db_pool_exhaustion: {
    runbookId: "rb-latency-pool",
    title: "Database Connection Pool Saturation",
    checks: [
      "Verify active vs. idle connections against Postgres max_connections",
      "Inspect long-running row-lock transactions holding connection slots",
    ],
  },
  webhook_timeout: {
    runbookId: "rb-webhook-retry",
    title: "Downstream Webhook Delivery Timeout",
    checks: [
      "Confirm idempotency key deduplication on retried deliveries",
      "Check dead-letter queue depth before increasing retry backoff",
    ],
  },
  auth_failure: {
    runbookId: "rb-hmac-rotation",
    title: "HMAC Signature Verification Mismatch",
    checks: [
      "Confirm clock skew is within AGENTGATE_WEBHOOK_MAX_AGE_SECONDS",
      "Verify overlapping secret rotation window between caller and ingress",
    ],
  },
  vlan_packet_loss: {
    runbookId: "rb-net-vlan",
    title: "Edge Switch / VLAN Latency & Packet Drop",
    checks: [
      "Inspect interface error counters and duplex negotiation on uplink ports",
      "Verify VLAN trunk tagging and QoS shaping policies",
    ],
  },
};

/** Pure deterministic log inspection helper backed by an injected log dictionary. */
export function inspectLogExcerpt(
  service: string,
  maxLines: number,
  logStore: Readonly<Record<string, readonly string[]>> = DEFAULT_LOGS,
): LogInspectionResult {
  const entries = logStore[service] ?? [];
  const clipped = entries.slice(0, maxLines);
  return {
    service,
    lines: clipped,
    truncated: entries.length > clipped.length,
  };
}

/** Classify observed p95 latency against service SLA budgets. */
export function checkLatencyBudget(
  service: string,
  p95Ms: number,
  budgets: Readonly<Record<string, number>> = SERVICE_BUDGETS_MS,
): LatencyBudgetResult {
  const budgetMs = budgets[service] ?? 500;
  const breached = p95Ms > budgetMs;
  const ratio = budgetMs > 0 ? p95Ms / budgetMs : 1;

  let recommendedSeverity: LatencyBudgetResult["recommendedSeverity"] = "low";
  if (ratio >= 3) {
    recommendedSeverity = "high";
  } else if (ratio > 1) {
    recommendedSeverity = "medium";
  }

  return {
    service,
    p95Ms,
    budgetMs,
    breached,
    recommendedSeverity,
  };
}

/** Resolve read-only remediation checklist for a known symptom tag. */
export function lookupRunbook(symptomTag: keyof typeof RUNBOOKS): RunbookEntry {
  const found = RUNBOOKS[symptomTag];
  if (!found) {
    throw new Error(`Unknown runbook symptom tag: ${symptomTag}`);
  }
  return found;
}
