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
  readonly baseline_pacing_wait_ms?: number;
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
  readonly p95_baseline_net_latency_ms?: number | null;
}

export interface McpCatalogRunbook {
  readonly runbookId: string;
  readonly title: string;
  readonly checks: readonly string[];
}

export interface McpCatalog {
  readonly maxLogLineLength: number;
  readonly defaultBudgetMs: number;
  readonly knownServices: readonly string[];
  readonly defaultLogs: Readonly<Record<string, readonly string[]>>;
  readonly serviceBudgetsMs: Readonly<Record<string, number>>;
  readonly symptomDescriptions: Readonly<Record<string, string>>;
  readonly runbooks: Readonly<Record<string, McpCatalogRunbook>>;
  readonly toolDescriptions: Readonly<Record<string, string>>;
  readonly parameterDescriptions: Readonly<Record<string, Readonly<Record<string, string>>>>;
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
  readonly isUploaded?: boolean;
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
  readonly p95BaselineNetMs: number | null;
  readonly p50ToolMs: number;
  readonly p95ToolMs: number;
  readonly p95ToolNetMs: number | null;
  readonly totalTokens: number;
  readonly baselineTotalTokens: number;
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

export function compareScenarioIds(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
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
  return [...report.results]
    .sort((a, b) => compareScenarioIds(a.scenario_id, b.scenario_id))
    .map((result) => {
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
  const summedBaselineTokens = rows.reduce((sum, row) => sum + (row.baseline_tokens ?? 0), 0);

  const hasToolPacing = rows.some((row) => typeof row.tool_pacing_wait_ms === "number");
  const p95ToolNetMs =
    typeof report.p95_tool_net_latency_ms === "number"
      ? report.p95_tool_net_latency_ms
      : report.p95_tool_net_latency_ms === null
        ? null
        : hasToolPacing
          ? computePercentile(
              rows.map((row) => Math.max(0, row.tool_latency_ms - (row.tool_pacing_wait_ms ?? 0))),
              0.95,
            )
          : null;

  const hasBaselinePacing = rows.some((row) => typeof row.baseline_pacing_wait_ms === "number");
  const p95BaselineNetMs =
    typeof report.p95_baseline_net_latency_ms === "number"
      ? report.p95_baseline_net_latency_ms
      : report.p95_baseline_net_latency_ms === null
        ? null
        : hasBaselinePacing
          ? computePercentile(
              rows.map((row) =>
                Math.max(0, row.baseline_latency_ms - (row.baseline_pacing_wait_ms ?? 0)),
              ),
              0.95,
            )
          : null;

  return {
    totalCases: rows.length,
    baselinePassedCount,
    toolPassedCount,
    deltaPp: (report.tool_pass_rate - report.baseline_pass_rate) * 100,
    schemaValidCount,
    adversarialTotal: adversarialRows.length,
    adversarialBlocked,
    p50BaselineMs: computePercentile(baselineLatencies, 0.5),
    p95BaselineMs: report.p95_baseline_latency_ms ?? computePercentile(baselineLatencies, 0.95),
    p95BaselineNetMs,
    p50ToolMs: computePercentile(toolLatencies, 0.5),
    p95ToolMs: report.p95_tool_latency_ms,
    p95ToolNetMs,
    totalTokens: summedTokens > 0 ? summedTokens : report.total_tokens,
    baselineTotalTokens:
      summedBaselineTokens > 0 ? summedBaselineTokens : (report.baseline_total_tokens ?? 0),
    improvedCount,
    regressedCount,
  };
}

const FAILURE_PATTERN_BY_CHECK: Readonly<Record<string, RegExp>> = {
  "tool-pass": /\btool_pass_rate\b|pass\s*rate|mcp\s*pass/i,
  delta: /\bdelta\b|improvement/i,
  schema: /\bschema\b/i,
  injection: /\binjection\b/i,
  p95: /\bp95\b|latency/i,
};

export function buildGateChecks(
  report: EvalSuiteReport,
  dataset: Pick<RunDataset, "latencyGateMs" | "minToolPassRate" | "minDelta" | "isUploaded">,
): readonly GateCheckRow[] {
  const delta = report.tool_pass_rate - report.baseline_pass_rate;
  const baseChecks: GateCheckRow[] = [
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

  const reconciled = baseChecks.map((check) => {
    if (!check.passed) {
      return check;
    }
    const pattern = Object.hasOwn(FAILURE_PATTERN_BY_CHECK, check.id)
      ? FAILURE_PATTERN_BY_CHECK[check.id]
      : undefined;
    if (!pattern) {
      return check;
    }
    const matchedFailure = report.gate_failures.find((failure) => pattern.test(failure));
    if (!matchedFailure) {
      return check;
    }
    return {
      ...check,
      target: dataset.isUploaded ? "Reported failure" : check.target,
      passed: false,
    };
  });

  if (!report.passed_ci_gate && reconciled.every((check) => check.passed)) {
    reconciled.push({
      id: "report-gate",
      label: "Reported CI gate status",
      measured: "Failed",
      target: "passed_ci_gate = true",
      passed: false,
    });
  }

  return reconciled;
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

function getOwn(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function requireNumber(obj: Record<string, unknown>, key: string): number {
  const val = getOwn(obj, key);
  if (typeof val !== "number" || !Number.isFinite(val)) {
    throw new Error(`Expected finite numeric field "${key}" in EvalSuiteReport JSON.`);
  }
  return val;
}

function requireNonNegativeNumber(obj: Record<string, unknown>, key: string): number {
  const val = requireNumber(obj, key);
  if (val < 0) {
    throw new Error(`Field "${key}" must be >= 0 (received ${val}).`);
  }
  return val;
}

function requireNonNegativeInteger(obj: Record<string, unknown>, key: string): number {
  const val = requireNonNegativeNumber(obj, key);
  if (!Number.isInteger(val)) {
    throw new Error(`Field "${key}" must be an integer (received ${val}).`);
  }
  return val;
}

function requireRate(obj: Record<string, unknown>, key: string): number {
  const val = requireNumber(obj, key);
  if (val < 0 || val > 1) {
    throw new Error(`Rate field "${key}" must be between 0 and 1 (received ${val}).`);
  }
  return val;
}

function requireBoolean(obj: Record<string, unknown>, key: string): boolean {
  const val = getOwn(obj, key);
  if (typeof val !== "boolean") {
    throw new Error(`Expected boolean field "${key}" in EvalSuiteReport JSON.`);
  }
  return val;
}

function optionalNonNegativeNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const val = getOwn(obj, key);
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val !== "number" || !Number.isFinite(val)) {
    throw new Error(`Expected finite numeric optional field "${key}" in EvalSuiteReport JSON.`);
  }
  if (val < 0) {
    throw new Error(`Optional field "${key}" must be >= 0 (received ${val}).`);
  }
  return val;
}

function optionalNullableNonNegativeNumber(
  obj: Record<string, unknown>,
  key: string,
): number | null | undefined {
  const val = getOwn(obj, key);
  if (val === undefined) {
    return undefined;
  }
  if (val === null) {
    return null;
  }
  if (typeof val !== "number" || !Number.isFinite(val)) {
    throw new Error(`Expected finite numeric|null field "${key}" in EvalSuiteReport JSON.`);
  }
  if (val < 0) {
    throw new Error(`Field "${key}" must be >= 0 (received ${val}).`);
  }
  return val;
}

function optionalNullableRate(
  obj: Record<string, unknown>,
  key: string,
): number | null | undefined {
  const val = getOwn(obj, key);
  if (val === undefined) {
    return undefined;
  }
  if (val === null) {
    return null;
  }
  if (typeof val !== "number" || !Number.isFinite(val)) {
    throw new Error(`Expected finite numeric|null rate field "${key}" in EvalSuiteReport JSON.`);
  }
  if (val < 0 || val > 1) {
    throw new Error(`Rate field "${key}" must be between 0 and 1 (received ${val}).`);
  }
  return val;
}

function optionalNullableString(
  obj: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const val = getOwn(obj, key);
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
  const val = getOwn(obj, key);
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

  const rawResults = getOwn(parsed, "results");
  if (!Array.isArray(rawResults)) {
    throw new Error('Expected "results" array in EvalSuiteReport JSON.');
  }

  const seenScenarioIds = new Set<string>();
  const results: EvalCaseResult[] = rawResults.map((item, idx) => {
    if (!isRecord(item)) {
      throw new Error(`Result entry at index ${idx} must be an object.`);
    }
    const rawScenarioId = getOwn(item, "scenario_id");
    if (typeof rawScenarioId !== "string" || rawScenarioId.trim().length === 0) {
      throw new Error(`Result entry at index ${idx} is missing "scenario_id".`);
    }
    const scenarioId = rawScenarioId.trim();
    if (seenScenarioIds.has(scenarioId)) {
      throw new Error(`Duplicate scenario_id "${scenarioId}" found at result index ${idx}.`);
    }
    seenScenarioIds.add(scenarioId);

    const baseResult: EvalCaseResult = {
      scenario_id: scenarioId,
      baseline_passed: requireBoolean(item, "baseline_passed"),
      tool_passed: requireBoolean(item, "tool_passed"),
      baseline_latency_ms: requireNonNegativeNumber(item, "baseline_latency_ms"),
      tool_latency_ms: requireNonNegativeNumber(item, "tool_latency_ms"),
      tool_schema_valid: requireBoolean(item, "tool_schema_valid"),
      injection_blocked: requireBoolean(item, "injection_blocked"),
      total_tokens: requireNonNegativeNumber(item, "total_tokens"),
    };
    const baselineSeverity = optionalSeverity(item, "baseline_severity");
    const baselineRunbook = optionalNullableString(item, "baseline_runbook");
    const baselineTokens = optionalNonNegativeNumber(item, "baseline_tokens");
    const baselinePacingWaitMs = optionalNonNegativeNumber(item, "baseline_pacing_wait_ms");
    const toolSeverity = optionalSeverity(item, "tool_severity");
    const toolRunbook = optionalNullableString(item, "tool_runbook");
    const toolCalls = optionalNonNegativeNumber(item, "tool_calls");
    const toolPacingWaitMs = optionalNonNegativeNumber(item, "tool_pacing_wait_ms");
    return {
      ...baseResult,
      ...(baselineSeverity !== undefined ? { baseline_severity: baselineSeverity } : {}),
      ...(baselineRunbook !== undefined ? { baseline_runbook: baselineRunbook } : {}),
      ...(baselineTokens !== undefined ? { baseline_tokens: baselineTokens } : {}),
      ...(baselinePacingWaitMs !== undefined
        ? { baseline_pacing_wait_ms: baselinePacingWaitMs }
        : {}),
      ...(toolSeverity !== undefined ? { tool_severity: toolSeverity } : {}),
      ...(toolRunbook !== undefined ? { tool_runbook: toolRunbook } : {}),
      ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
      ...(toolPacingWaitMs !== undefined ? { tool_pacing_wait_ms: toolPacingWaitMs } : {}),
    };
  });

  const totalCases = requireNonNegativeInteger(parsed, "total_cases");
  if (totalCases !== results.length) {
    throw new Error(
      `Report "total_cases" (${totalCases}) does not match "results" length (${results.length}).`,
    );
  }

  const rawFailures = getOwn(parsed, "gate_failures");
  if (rawFailures !== undefined && !Array.isArray(rawFailures)) {
    throw new Error('Field "gate_failures" must be an array of strings when present.');
  }
  const gateFailures = Array.isArray(rawFailures)
    ? rawFailures.filter((item): item is string => typeof item === "string")
    : [];

  const baselineSchemaValidRate = optionalNullableRate(parsed, "baseline_schema_valid_rate");
  const baselineInjectionBlockRate = optionalNullableRate(
    parsed,
    "baseline_injection_block_rate",
  );
  const p95BaselineLatencyMs = optionalNonNegativeNumber(parsed, "p95_baseline_latency_ms");
  const baselineTotalTokens = optionalNonNegativeNumber(parsed, "baseline_total_tokens");
  const p95ToolNetLatencyMs = optionalNullableNonNegativeNumber(parsed, "p95_tool_net_latency_ms");
  const p95BaselineNetLatencyMs = optionalNullableNonNegativeNumber(
    parsed,
    "p95_baseline_net_latency_ms",
  );

  return {
    total_cases: totalCases,
    baseline_pass_rate: requireRate(parsed, "baseline_pass_rate"),
    tool_pass_rate: requireRate(parsed, "tool_pass_rate"),
    schema_valid_rate: requireRate(parsed, "schema_valid_rate"),
    injection_block_rate: requireRate(parsed, "injection_block_rate"),
    p95_tool_latency_ms: requireNonNegativeNumber(parsed, "p95_tool_latency_ms"),
    total_tokens: requireNonNegativeNumber(parsed, "total_tokens"),
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
    ...(baselineTotalTokens !== undefined ? { baseline_total_tokens: baselineTotalTokens } : {}),
    ...(p95ToolNetLatencyMs !== undefined
      ? { p95_tool_net_latency_ms: p95ToolNetLatencyMs }
      : {}),
    ...(p95BaselineNetLatencyMs !== undefined
      ? { p95_baseline_net_latency_ms: p95BaselineNetLatencyMs }
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
