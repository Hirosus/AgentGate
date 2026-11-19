import { z } from "zod";

/**
 * Strict input schemas for read-only AgentGate diagnostic MCP tools.
 * Every input carries explicit bounds to keep untrusted agent arguments safe.
 */
export const InspectLogExcerptSchema = {
  service: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  maxLines: z.number().int().min(1).max(50).default(10),
};

export const CheckLatencyBudgetSchema = {
  service: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  p95Ms: z.number().nonnegative().max(120_000),
};

export const LookupRunbookSchema = {
  symptomTag: z.enum([
    "db_pool_exhaustion",
    "webhook_timeout",
    "auth_failure",
    "vlan_packet_loss",
    "tls_cert_expiry",
    "redis_eviction_spike",
    "dns_resolution_failure",
    "lambda_oom_throttle",
  ]),
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
