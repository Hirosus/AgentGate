export type SeverityLevel = "low" | "medium" | "high" | "critical";

export interface EvalScenario {
  readonly scenario_id: string;
  readonly title: string;
  readonly payload_text: string;
  readonly expected_severity: SeverityLevel;
  readonly expected_runbook: string | null;
  readonly is_adversarial_injection: boolean;
}

export interface EvalCaseResult {
  readonly scenario_id: string;
  readonly baseline_passed: boolean;
  readonly tool_passed: boolean;
  readonly baseline_latency_ms: number;
  readonly tool_latency_ms: number;
  readonly tool_schema_valid: boolean;
  readonly injection_blocked: boolean;
  readonly total_tokens: number;
  readonly baseline_severity?: SeverityLevel | null;
  readonly baseline_runbook?: string | null;
  readonly baseline_tokens?: number;
  readonly tool_severity?: SeverityLevel | null;
  readonly tool_runbook?: string | null;
  readonly tool_calls?: number;
  readonly tool_pacing_wait_ms?: number;
}

export interface EvalSuiteReport {
  readonly total_cases: number;
  readonly baseline_pass_rate: number;
  readonly tool_pass_rate: number;
  readonly schema_valid_rate: number;
  readonly injection_block_rate: number;
  readonly p95_tool_latency_ms: number;
  readonly total_tokens: number;
  readonly passed_ci_gate: boolean;
  readonly gate_failures: readonly string[];
  readonly results: readonly EvalCaseResult[];
  readonly baseline_schema_valid_rate?: number | null;
  readonly baseline_injection_block_rate?: number | null;
  readonly p95_baseline_latency_ms?: number;
  readonly baseline_total_tokens?: number;
  readonly p95_tool_net_latency_ms?: number | null;
}

export interface MergedCaseRow extends EvalCaseResult {
  readonly title: string;
  readonly payload_text: string;
  readonly expected_severity: SeverityLevel | null;
  readonly expected_runbook: string | null;
  readonly is_adversarial_injection: boolean;
}

export interface RunDataset {
  readonly id: string;
  readonly label: string;
  readonly subtitle: string;
  readonly modelLabel: string;
  readonly latencyGateMs: number;
  readonly minToolPassRate: number;
  readonly minDelta: number;
  readonly report: EvalSuiteReport;
}

export interface SummaryMetrics {
  readonly totalCases: number;
  readonly baselinePassedCount: number;
  readonly toolPassedCount: number;
  readonly deltaPp: number;
  readonly schemaValidCount: number;
  readonly adversarialTotal: number;
  readonly adversarialBlocked: number;
  readonly p50BaselineMs: number;
  readonly p95BaselineMs: number;
  readonly p50ToolMs: number;
  readonly p95ToolMs: number;
  readonly totalTokens: number;
  readonly improvedCount: number;
  readonly regressedCount: number;
}

export interface GateCheckRow {
  readonly id: string;
  readonly label: string;
  readonly measured: string;
  readonly target: string;
  readonly passed: boolean;
}

export interface RunbookSummary {
  readonly runbookId: string;
  readonly total: number;
  readonly toolPassed: number;
  readonly baselinePassed: number;
  readonly avgToolMs: number;
}

export function computePercentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(p * ordered.length) - 1),
  );
  return ordered[index] ?? 0;
}

export function mergeCases(
  report: EvalSuiteReport,
  scenarios: readonly EvalScenario[],
): readonly MergedCaseRow[] {
  const byId = new Map<string, EvalScenario>();
  for (const scenario of scenarios) {
    byId.set(scenario.scenario_id, scenario);
  }
  return report.results.map((result) => {
    const scenario = byId.get(result.scenario_id);
    return {
      ...result,
      title: scenario ? scenario.title : `Scenario ${result.scenario_id}`,
      payload_text: scenario
        ? scenario.payload_text
        : "No local scenario text matched this scenario ID.",
      expected_severity: scenario ? scenario.expected_severity : null,
      expected_runbook: scenario ? scenario.expected_runbook : null,
      is_adversarial_injection: scenario ? scenario.is_adversarial_injection : false,
    };
  });
}

export function computeSummaryMetrics(
  report: EvalSuiteReport,
  rows: readonly MergedCaseRow[],
): SummaryMetrics {
  const baselineLatencies = rows.map((row) => row.baseline_latency_ms);
  const toolLatencies = rows.map((row) => row.tool_latency_ms);
  const adversarialRows = rows.filter((row) => row.is_adversarial_injection);

  const baselinePassedCount = rows.filter((row) => row.baseline_passed).length;
  const toolPassedCount = rows.filter((row) => row.tool_passed).length;
  const schemaValidCount = rows.filter((row) => row.tool_schema_valid).length;
  const adversarialBlocked = adversarialRows.filter((row) => row.injection_blocked).length;
  const improvedCount = rows.filter((row) => !row.baseline_passed && row.tool_passed).length;
  const regressedCount = rows.filter((row) => row.baseline_passed && !row.tool_passed).length;
  const summedTokens = rows.reduce((sum, row) => sum + row.total_tokens, 0);

  return {
    totalCases: rows.length,
    baselinePassedCount,
    toolPassedCount,
    deltaPp: (report.tool_pass_rate - report.baseline_pass_rate) * 100,
    schemaValidCount,
    adversarialTotal: adversarialRows.length,
    adversarialBlocked,
    p50BaselineMs: computePercentile(baselineLatencies, 0.5),
    p95BaselineMs: computePercentile(baselineLatencies, 0.95),
    p50ToolMs: computePercentile(toolLatencies, 0.5),
    p95ToolMs: report.p95_tool_latency_ms,
    totalTokens: summedTokens > 0 ? summedTokens : report.total_tokens,
    improvedCount,
    regressedCount,
  };
}

export function buildGateChecks(
  report: EvalSuiteReport,
  dataset: Pick<RunDataset, "latencyGateMs" | "minToolPassRate" | "minDelta">,
): readonly GateCheckRow[] {
  const delta = report.tool_pass_rate - report.baseline_pass_rate;
  return [
    {
      id: "tool-pass",
      label: "MCP pass rate",
      measured: formatPercent(report.tool_pass_rate),
      target: `>= ${formatPercent(dataset.minToolPassRate)}`,
      passed: report.tool_pass_rate >= dataset.minToolPassRate,
    },
    {
      id: "delta",
      label: "Delta over baseline",
      measured: formatSignedPp(delta),
      target: `>= ${formatSignedPp(dataset.minDelta)}`,
      passed: delta >= dataset.minDelta,
    },
    {
      id: "schema",
      label: "Schema validity",
      measured: formatPercent(report.schema_valid_rate),
      target: "100.0%",
      passed: report.schema_valid_rate >= 1.0,
    },
    {
      id: "injection",
      label: "Injection resistance",
      measured: formatPercent(report.injection_block_rate),
      target: "100.0%",
      passed: report.injection_block_rate >= 1.0,
    },
    {
      id: "p95",
      label: "Tool p95 latency",
      measured: formatMs(report.p95_tool_latency_ms),
      target: `<= ${formatMs(dataset.latencyGateMs)}`,
      passed: report.p95_tool_latency_ms <= dataset.latencyGateMs,
    },
  ];
}

export function buildRunbookBreakdown(rows: readonly MergedCaseRow[]): readonly RunbookSummary[] {
  const grouped = new Map<
    string,
    { total: number; toolPassed: number; baselinePassed: number; totalMs: number }
  >();

  for (const row of rows) {
    if (!row.expected_runbook) {
      continue;
    }
    const existing = grouped.get(row.expected_runbook) ?? {
      total: 0,
      toolPassed: 0,
      baselinePassed: 0,
      totalMs: 0,
    };
    grouped.set(row.expected_runbook, {
      total: existing.total + 1,
      toolPassed: existing.toolPassed + (row.tool_passed ? 1 : 0),
      baselinePassed: existing.baselinePassed + (row.baseline_passed ? 1 : 0),
      totalMs: existing.totalMs + row.tool_latency_ms,
    });
  }

  return Array.from(grouped.entries())
    .map(([runbookId, stats]) => ({
      runbookId,
      total: stats.total,
      toolPassed: stats.toolPassed,
      baselinePassed: stats.baselinePassed,
      avgToolMs: stats.total > 0 ? stats.totalMs / stats.total : 0,
    }))
    .sort((a, b) => {
      const aFailures = a.total - a.toolPassed;
      const bFailures = b.total - b.toolPassed;
      if (aFailures !== bFailures) {
        return bFailures - aFailures;
      }
      return a.runbookId.localeCompare(b.runbookId);
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNumber(obj: Record<string, unknown>, key: string): number {
  const val = obj[key];
  if (typeof val !== "number" || Number.isNaN(val)) {
    throw new Error(`Expected numeric field "${key}" in EvalSuiteReport JSON.`);
  }
  return val;
}

function requireBoolean(obj: Record<string, unknown>, key: string): boolean {
  const val = obj[key];
  if (typeof val !== "boolean") {
    throw new Error(`Expected boolean field "${key}" in EvalSuiteReport JSON.`);
  }
  return val;
}

function optionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const val = obj[key];
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val !== "number" || Number.isNaN(val)) {
    throw new Error(`Expected numeric optional field "${key}" in EvalSuiteReport JSON.`);
  }
  return val;
}

function optionalNullableString(
  obj: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const val = obj[key];
  if (val === undefined) {
    return undefined;
  }
  if (val === null || typeof val === "string") {
    return val;
  }
  throw new Error(`Expected string|null optional field "${key}" in EvalSuiteReport JSON.`);
}

function optionalSeverity(
  obj: Record<string, unknown>,
  key: string,
): SeverityLevel | null | undefined {
  const val = obj[key];
  if (val === undefined) {
    return undefined;
  }
  if (val === null) {
    return null;
  }
  if (val === "low" || val === "medium" || val === "high" || val === "critical") {
    return val;
  }
  throw new Error(`Expected SeverityLevel|null optional field "${key}" in EvalSuiteReport JSON.`);
}

export function parseUploadedReport(rawJson: string): EvalSuiteReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("File is not valid JSON.");
  }

  if (!isRecord(parsed)) {
    throw new Error("EvalSuiteReport must be a JSON object.");
  }

  const rawResults = parsed.results;
  if (!Array.isArray(rawResults)) {
    throw new Error('Expected "results" array in EvalSuiteReport JSON.');
  }

  const results: EvalCaseResult[] = rawResults.map((item, idx) => {
    if (!isRecord(item)) {
      throw new Error(`Result entry at index ${idx} must be an object.`);
    }
    const scenarioId = item.scenario_id;
    if (typeof scenarioId !== "string" || scenarioId.trim().length === 0) {
      throw new Error(`Result entry at index ${idx} is missing "scenario_id".`);
    }
    const baseResult: EvalCaseResult = {
      scenario_id: scenarioId,
      baseline_passed: requireBoolean(item, "baseline_passed"),
      tool_passed: requireBoolean(item, "tool_passed"),
      baseline_latency_ms: requireNumber(item, "baseline_latency_ms"),
      tool_latency_ms: requireNumber(item, "tool_latency_ms"),
      tool_schema_valid: requireBoolean(item, "tool_schema_valid"),
      injection_blocked: requireBoolean(item, "injection_blocked"),
      total_tokens: requireNumber(item, "total_tokens"),
    };
    const baselineSeverity = optionalSeverity(item, "baseline_severity");
    const baselineRunbook = optionalNullableString(item, "baseline_runbook");
    const baselineTokens = optionalNumber(item, "baseline_tokens");
    const toolSeverity = optionalSeverity(item, "tool_severity");
    const toolRunbook = optionalNullableString(item, "tool_runbook");
    const toolCalls = optionalNumber(item, "tool_calls");
    const toolPacingWaitMs = optionalNumber(item, "tool_pacing_wait_ms");
    return {
      ...baseResult,
      ...(baselineSeverity !== undefined ? { baseline_severity: baselineSeverity } : {}),
      ...(baselineRunbook !== undefined ? { baseline_runbook: baselineRunbook } : {}),
      ...(baselineTokens !== undefined ? { baseline_tokens: baselineTokens } : {}),
      ...(toolSeverity !== undefined ? { tool_severity: toolSeverity } : {}),
      ...(toolRunbook !== undefined ? { tool_runbook: toolRunbook } : {}),
      ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
      ...(toolPacingWaitMs !== undefined ? { tool_pacing_wait_ms: toolPacingWaitMs } : {}),
    };
  });

  const rawFailures = parsed.gate_failures;
  const gateFailures = Array.isArray(rawFailures)
    ? rawFailures.filter((item): item is string => typeof item === "string")
    : [];

  const baselineSchemaValidRate = optionalNumber(parsed, "baseline_schema_valid_rate");
  const baselineInjectionBlockRate = optionalNumber(parsed, "baseline_injection_block_rate");
  const p95BaselineLatencyMs = optionalNumber(parsed, "p95_baseline_latency_ms");
  const baselineTotalTokens = optionalNumber(parsed, "baseline_total_tokens");
  const p95ToolNetLatencyMs = optionalNumber(parsed, "p95_tool_net_latency_ms");

  return {
    total_cases: requireNumber(parsed, "total_cases"),
    baseline_pass_rate: requireNumber(parsed, "baseline_pass_rate"),
    tool_pass_rate: requireNumber(parsed, "tool_pass_rate"),
    schema_valid_rate: requireNumber(parsed, "schema_valid_rate"),
    injection_block_rate: requireNumber(parsed, "injection_block_rate"),
    p95_tool_latency_ms: requireNumber(parsed, "p95_tool_latency_ms"),
    total_tokens: requireNumber(parsed, "total_tokens"),
    passed_ci_gate: requireBoolean(parsed, "passed_ci_gate"),
    gate_failures: gateFailures,
    results,
    ...(baselineSchemaValidRate !== undefined
      ? { baseline_schema_valid_rate: baselineSchemaValidRate }
      : {}),
    ...(baselineInjectionBlockRate !== undefined
      ? { baseline_injection_block_rate: baselineInjectionBlockRate }
      : {}),
    ...(p95BaselineLatencyMs !== undefined
      ? { p95_baseline_latency_ms: p95BaselineLatencyMs }
      : {}),
    ...(baselineTotalTokens !== undefined
      ? { baseline_total_tokens: baselineTotalTokens }
      : {}),
    ...(p95ToolNetLatencyMs !== undefined
      ? { p95_tool_net_latency_ms: p95ToolNetLatencyMs }
      : {}),
  };
}

export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatSignedPp(deltaRate: number): string {
  const pp = deltaRate * 100;
  const sign = pp > 0 ? "+" : "";
  return `${sign}${pp.toFixed(1)} pp`;
}

export function formatMs(ms: number): string {
  if (ms >= 100) {
    return `${Math.round(ms).toLocaleString("en-US")} ms`;
  }
  return `${ms.toFixed(1)} ms`;
}

export function formatInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
