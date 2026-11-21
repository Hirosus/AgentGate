import { z } from "zod";
import catalog from "./catalog.json" with { type: "json" };

export const SYMPTOM_TAGS = [
  "db_pool_exhaustion",
  "webhook_timeout",
  "auth_failure",
  "vlan_packet_loss",
  "tls_cert_expiry",
  "redis_eviction_spike",
  "dns_resolution_failure",
  "lambda_oom_throttle",
] as const;

export type SymptomTag = (typeof SYMPTOM_TAGS)[number];

const SYMPTOM_CATEGORY_SUMMARY = SYMPTOM_TAGS.map(
  (tag) => `${tag} (${catalog.symptomDescriptions[tag]})`,
).join(", ");

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
    .describe(catalog.parameterDescriptions.inspect_log_excerpt.service),
  maxLines: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe(catalog.parameterDescriptions.inspect_log_excerpt.maxLines),
};

export const CheckLatencyBudgetSchema = {
  service: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/)
    .describe(catalog.parameterDescriptions.check_latency_budget.service),
  p95Ms: z
    .number()
    .nonnegative()
    .max(120_000)
    .describe(catalog.parameterDescriptions.check_latency_budget.p95Ms),
};

export const LookupRunbookSchema = {
  symptomTag: z
    .enum(SYMPTOM_TAGS)
    .describe(`Symptom category: ${SYMPTOM_CATEGORY_SUMMARY}.`),
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
