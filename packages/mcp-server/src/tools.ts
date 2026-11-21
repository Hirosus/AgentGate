import catalog from "./catalog.json" with { type: "json" };
import type {
  LatencyBudgetResult,
  LogInspectionResult,
  RunbookEntry,
  SymptomTag,
} from "./schemas.js";

const MAX_LOG_LINE_LENGTH = catalog.maxLogLineLength;
const DEFAULT_BUDGET_MS = catalog.defaultBudgetMs;

export const DEFAULT_LOGS: Readonly<Record<string, readonly string[]>> = catalog.defaultLogs;

export const SERVICE_BUDGETS_MS: Readonly<Record<string, number>> = catalog.serviceBudgetsMs;

export const RUNBOOKS: Readonly<Record<SymptomTag, RunbookEntry>> = catalog.runbooks;

function sanitizeLogLine(line: string): string {
  // Collapse ASCII control chars so untrusted log telemetry stays single-line plain text.
  const cleaned = line.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  if (cleaned.length <= MAX_LOG_LINE_LENGTH) {
    return cleaned;
  }
  return `${cleaned.slice(0, MAX_LOG_LINE_LENGTH - 3)}...`;
}

/** Pure deterministic log inspection helper backed by an injected log dictionary. */
export function inspectLogExcerpt(
  service: string,
  maxLines = 10,
  logStore: Readonly<Record<string, readonly string[]>> = DEFAULT_LOGS,
): LogInspectionResult {
  const entries = Object.hasOwn(logStore, service) ? (logStore[service] ?? []) : [];
  const boundedLines = Number.isFinite(maxLines)
    ? Math.max(1, Math.min(50, Math.trunc(maxLines)))
    : 10;
  const clipped = entries.slice(0, boundedLines).map(sanitizeLogLine);
  return {
    service,
    lines: clipped,
    truncated: entries.length > clipped.length,
    untrustedTelemetry: true,
  };
}

/** Classify observed p95 latency against service SLA budgets. */
export function checkLatencyBudget(
  service: string,
  p95Ms: number,
  budgets: Readonly<Record<string, number>> = SERVICE_BUDGETS_MS,
): LatencyBudgetResult {
  const budgetMs = Object.hasOwn(budgets, service)
    ? (budgets[service] ?? DEFAULT_BUDGET_MS)
    : DEFAULT_BUDGET_MS;
  const breached = p95Ms > budgetMs;
  const ratio = budgetMs > 0 ? p95Ms / budgetMs : 1;

  let recommendedSeverity: LatencyBudgetResult["recommendedSeverity"] = "low";
  if (ratio >= 5) {
    recommendedSeverity = "critical";
  } else if (ratio >= 3) {
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
  const found = Object.hasOwn(RUNBOOKS, symptomTag) ? RUNBOOKS[symptomTag] : undefined;
  if (!found) {
    throw new Error(`Unknown runbook symptom tag: ${String(symptomTag)}`);
  }
  return found;
}
