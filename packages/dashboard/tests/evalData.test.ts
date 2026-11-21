import assert from "node:assert/strict";
import { describe, it } from "node:test";
import geminiReportJson from "../src/data/gemini-report.json";
import latestReportJson from "../src/data/latest-report.json";
import scenariosJson from "../src/data/scenarios.json";
import {
  buildGateChecks,
  compareScenarioIds,
  computeSummaryMetrics,
  mergeCases,
  parseUploadedReport,
  type EvalScenario,
} from "../src/lib/evalData";

function makeValidReportPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    total_cases: 2,
    baseline_pass_rate: 0.5,
    tool_pass_rate: 1.0,
    schema_valid_rate: 1.0,
    injection_block_rate: 1.0,
    p95_tool_latency_ms: 8200,
    p95_tool_net_latency_ms: 2200,
    p95_baseline_latency_ms: 4100,
    p95_baseline_net_latency_ms: 1100,
    total_tokens: 3000,
    baseline_total_tokens: 600,
    baseline_schema_valid_rate: 1.0,
    baseline_injection_block_rate: 1.0,
    passed_ci_gate: true,
    gate_failures: [],
    results: [
      {
        scenario_id: "inc-10",
        baseline_passed: false,
        tool_passed: true,
        baseline_latency_ms: 4100,
        baseline_pacing_wait_ms: 3000,
        tool_latency_ms: 8200,
        tool_pacing_wait_ms: 6000,
        tool_schema_valid: true,
        injection_blocked: true,
        total_tokens: 1800,
        baseline_tokens: 350,
      },
      {
        scenario_id: "inc-2",
        baseline_passed: true,
        tool_passed: true,
        baseline_latency_ms: 3500,
        baseline_pacing_wait_ms: 2500,
        tool_latency_ms: 7100,
        tool_pacing_wait_ms: 5500,
        tool_schema_valid: true,
        injection_blocked: true,
        total_tokens: 1200,
        baseline_tokens: 250,
      },
    ],
    ...overrides,
  };
}

describe("evalData parsing, metrics, and validation", () => {
  it("parses committed gemini-report.json and latest-report.json cleanly", () => {
    const scenarios = scenariosJson as readonly EvalScenario[];

    const gemini = parseUploadedReport(JSON.stringify(geminiReportJson));
    const geminiMerged = mergeCases(gemini, scenarios);
    const geminiSummary = computeSummaryMetrics(gemini, geminiMerged);

    assert.equal(gemini.total_cases, 20);
    assert.equal(geminiMerged.length, 20);
    assert.equal(geminiSummary.totalTokens, 40363);
    assert.equal(geminiSummary.baselineTotalTokens, 5637);
    assert.ok(geminiSummary.p95ToolNetMs !== null && geminiSummary.p95ToolNetMs > 0);
    assert.equal(geminiSummary.p95ToolNetMs, gemini.p95_tool_net_latency_ms);
    assert.ok(geminiSummary.p95BaselineNetMs !== null && geminiSummary.p95BaselineNetMs > 0);
    assert.equal(geminiSummary.p95BaselineNetMs, gemini.p95_baseline_net_latency_ms);

    const deterministic = parseUploadedReport(JSON.stringify(latestReportJson));
    const detMerged = mergeCases(deterministic, scenarios);
    const detSummary = computeSummaryMetrics(deterministic, detMerged);

    assert.equal(deterministic.total_cases, 20);
    assert.equal(detSummary.totalTokens, 0);
    assert.equal(detSummary.baselineTotalTokens, 0);
    assert.equal(detSummary.p95BaselineNetMs, deterministic.p95_baseline_net_latency_ms);
  });

  it("extracts p95_baseline_net_latency_ms and baseline_pacing_wait_ms and sorts naturally", () => {
    const raw = JSON.stringify(makeValidReportPayload());
    const parsed = parseUploadedReport(raw);

    assert.equal(parsed.p95_baseline_net_latency_ms, 1100);
    assert.equal(parsed.results[0]?.baseline_pacing_wait_ms, 3000);
    assert.equal(parsed.results[1]?.baseline_pacing_wait_ms, 2500);

    const rows = mergeCases(parsed, scenariosJson as readonly EvalScenario[]);
    assert.deepEqual(
      rows.map((r) => r.scenario_id),
      ["inc-2", "inc-10"],
    );
    assert.ok(compareScenarioIds("inc-2", "inc-10") < 0);
    assert.ok(compareScenarioIds("inc-10", "inc-2") > 0);

    const summary = computeSummaryMetrics(parsed, rows);
    assert.equal(summary.p95ToolNetMs, 2200);
    assert.equal(summary.p95BaselineNetMs, 1100);
    assert.equal(summary.baselineTotalTokens, 600);

    // Falls back to computing net p95 from per-case pacing wait when top-level net fields are omitted.
    const noTopNet = makeValidReportPayload();
    delete noTopNet.p95_baseline_net_latency_ms;
    delete noTopNet.p95_tool_net_latency_ms;
    const fallbackParsed = parseUploadedReport(JSON.stringify(noTopNet));
    const fallbackRows = mergeCases(fallbackParsed, []);
    const fallbackSummary = computeSummaryMetrics(fallbackParsed, fallbackRows);
    assert.equal(fallbackSummary.p95ToolNetMs, 2200);
    assert.equal(fallbackSummary.p95BaselineNetMs, 1100);
  });

  it("rejects out-of-range rates in [0, 1]", () => {
    const rateFields = [
      "baseline_pass_rate",
      "tool_pass_rate",
      "schema_valid_rate",
      "injection_block_rate",
      "baseline_schema_valid_rate",
      "baseline_injection_block_rate",
    ];

    for (const field of rateFields) {
      assert.throws(
        () => parseUploadedReport(JSON.stringify(makeValidReportPayload({ [field]: -0.01 }))),
        /between 0 and 1/,
        `Expected negative ${field} to throw`,
      );
      assert.throws(
        () => parseUploadedReport(JSON.stringify(makeValidReportPayload({ [field]: 1.01 }))),
        /between 0 and 1/,
        `Expected >1 ${field} to throw`,
      );
    }
  });

  it("rejects negative or non-finite latencies and token counts", () => {
    assert.throws(
      () => parseUploadedReport(JSON.stringify(makeValidReportPayload({ p95_tool_latency_ms: -5 }))),
      />= 0/,
    );
    assert.throws(
      () => parseUploadedReport(JSON.stringify(makeValidReportPayload({ total_tokens: -1 }))),
      />= 0/,
    );
    assert.throws(
      () =>
        parseUploadedReport(
          JSON.stringify(makeValidReportPayload({ p95_baseline_net_latency_ms: -10 })),
        ),
      />= 0/,
    );

    const base = makeValidReportPayload();
    const cases = base.results as Array<Record<string, unknown>>;
    assert.throws(
      () =>
        parseUploadedReport(
          JSON.stringify({
            ...base,
            results: [{ ...cases[0], baseline_pacing_wait_ms: -1 }, cases[1]],
          }),
        ),
      />= 0/,
    );
    assert.throws(
      () =>
        parseUploadedReport(
          JSON.stringify({
            ...base,
            results: [{ ...cases[0], tool_latency_ms: -100 }, cases[1]],
          }),
        ),
      />= 0/,
    );
    assert.throws(
      () =>
        parseUploadedReport(
          JSON.stringify({
            ...base,
            results: [{ ...cases[0], baseline_tokens: -3 }, cases[1]],
          }),
        ),
      />= 0/,
    );
  });

  it("rejects duplicate scenario_id entries and total_cases mismatches", () => {
    const base = makeValidReportPayload();
    const cases = base.results as Array<Record<string, unknown>>;

    assert.throws(
      () =>
        parseUploadedReport(
          JSON.stringify({
            ...base,
            results: [cases[0], { ...cases[1], scenario_id: " inc-10 " }],
          }),
        ),
      /Duplicate scenario_id/,
    );

    assert.throws(
      () => parseUploadedReport(JSON.stringify(makeValidReportPayload({ total_cases: 5 }))),
      /does not match "results" length/,
    );
  });

  it("reconciles buildGateChecks honestly when uploaded report fails CI gate", () => {
    const failedUploaded = parseUploadedReport(
      JSON.stringify(
        makeValidReportPayload({
          tool_pass_rate: 0.9,
          passed_ci_gate: false,
          gate_failures: ["tool_pass_rate 0.900 < 0.950"],
        }),
      ),
    );
    const checks = buildGateChecks(failedUploaded, {
      latencyGateMs: 20000,
      minToolPassRate: 0.85,
      minDelta: 0.0,
      isUploaded: true,
    });
    const toolPassCheck = checks.find((c) => c.id === "tool-pass");
    assert.equal(toolPassCheck?.passed, false);
    assert.equal(checks.some((c) => !c.passed), true);

    const unrecognizedFailure = parseUploadedReport(
      JSON.stringify(
        makeValidReportPayload({
          passed_ci_gate: false,
          gate_failures: ["custom_external_policy_check failed"],
        }),
      ),
    );
    const fallbackChecks = buildGateChecks(unrecognizedFailure, {
      latencyGateMs: 20000,
      minToolPassRate: 0.85,
      minDelta: 0.0,
      isUploaded: true,
    });
    assert.equal(fallbackChecks.some((c) => !c.passed), true);
  });
});
