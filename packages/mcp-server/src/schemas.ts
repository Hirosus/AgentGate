import { z } from "zod";

/**
 * Strict input schemas for read-only AgentGate diagnostic MCP tools.
 * Every input carries explicit bounds to keep untrusted agent arguments safe.
 */
export const InspectLogExcerptSchema = {
  service: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/)
    .describe("Lowercase service identifier (e.g. checkout-api, webhook-ingress, auth-gateway)."),
  maxLines: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Maximum number of bounded log lines to return (1-50)."),
};

export const CheckLatencyBudgetSchema = {
  service: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/)
    .describe("Lowercase service identifier to look up SLA p95 latency budget."),
  p95Ms: z
    .number()
    .nonnegative()
    .max(120_000)
    .describe("Observed p95 latency in milliseconds from the alert."),
};

export const LookupRunbookSchema = {
  symptomTag: z
    .enum([
      "db_pool_exhaustion",
      "webhook_timeout",
      "auth_failure",
      "vlan_packet_loss",
      "tls_cert_expiry",
      "redis_eviction_spike",
      "dns_resolution_failure",
      "lambda_oom_throttle",
    ])
    .describe(
      "Symptom category: db_pool_exhaustion (Postgres connection pool or row-lock saturation), " +
        "webhook_timeout (outbound/downstream webhook delivery 5xx, timeout, retry backoff, or DLQ), " +
        "auth_failure (inbound HMAC/signature verification mismatch, secret rotation, or clock skew), " +
        "vlan_packet_loss (switch VLAN CRC errors or uplink packet loss), " +
        "tls_cert_expiry (expired X.509/TLS certificate or handshake outage), " +
        "redis_eviction_spike (Redis maxmemory saturation, key evictions, or hit ratio drop), " +
        "dns_resolution_failure (CoreDNS upstream SERVFAIL or lookup timeout), " +
        "lambda_oom_throttle (AWS Lambda OutOfMemory or 429 concurrency throttle).",
    ),
};

export interface LogInspectionResult {
  readonly service: string;
  readonly lines: readonly string[];
  readonly truncated: boolean;
  readonly untrustedTelemetry: boolean;
}

export interface LatencyBudgetResult {
  readonly service: string;
  readonly p95Ms: number;
  readonly budgetMs: number;
  readonly breached: boolean;
  readonly recommendedSeverity: "low" | "medium" | "high" | "critical";
}

export interface RunbookEntry {
  readonly runbookId: string;
  readonly title: string;
  readonly checks: readonly string[];
}
