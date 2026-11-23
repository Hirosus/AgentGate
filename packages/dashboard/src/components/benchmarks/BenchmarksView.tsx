"use client";

import type { ChangeEvent, RefObject } from "react";
import { PairedEvalChart } from "@/components/PairedEvalChart";
import { ScenarioDetailPanel } from "@/components/ScenarioDetailPanel";
import {
  formatInt,
  formatMs,
  formatPercent,
  formatSignedPp,
  type GateCheckRow,
  type MergedCaseRow,
  type RunDataset,
  type SummaryMetrics,
} from "@/lib/evalData";

export type ScenarioTab = "all" | "failed" | "improved" | "adversarial";
export type SortOption = "id" | "latency" | "tokens";

interface BenchmarksViewProps {
  readonly allDatasets: readonly RunDataset[];
  readonly activeDataset: RunDataset | undefined;
  readonly summary: SummaryMetrics | null;
  readonly mergedRows: readonly MergedCaseRow[];
  readonly filteredScenarios: readonly MergedCaseRow[];
  readonly failingCount: number;
  readonly gateChecks: readonly GateCheckRow[];
  readonly selectedScenarioId: string | null;
  readonly selectedDetailRow: MergedCaseRow | null;
  readonly scenarioTab: ScenarioTab;
  readonly setScenarioTab: (tab: ScenarioTab) => void;
  readonly searchQuery: string;
  readonly setSearchQuery: (q: string) => void;
  readonly sortBy: SortOption;
  readonly setSortBy: (s: SortOption) => void;
  readonly uploadError: string | null;
  readonly fileInputRef: RefObject<HTMLInputElement | null>;
  readonly detailPanelRef: RefObject<HTMLDivElement | null>;
  readonly onSelectRun: (runId: string) => void;
  readonly onReportUpload: (e: ChangeEvent<HTMLInputElement>) => Promise<void>;
  readonly onSelectScenario: (scenarioId: string, toggleIfSame: boolean) => void;
  readonly onClearScenario: () => void;
  readonly onLoadInWorkbench: (row: MergedCaseRow) => void;
}

export function BenchmarksView({
  allDatasets,
  activeDataset,
  summary,
  mergedRows,
  filteredScenarios,
  failingCount,
  gateChecks,
  selectedScenarioId,
  selectedDetailRow,
  scenarioTab,
  setScenarioTab,
  searchQuery,
  setSearchQuery,
  sortBy,
  setSortBy,
  uploadError,
  fileInputRef,
  detailPanelRef,
  onSelectRun,
  onReportUpload,
  onSelectScenario,
  onClearScenario,
  onLoadInWorkbench,
}: BenchmarksViewProps) {
  const report = activeDataset?.report ?? null;

  if (!activeDataset || !report || !summary) {
    return (
      <section className="rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-[14px] text-[var(--muted)]">
        No evaluation report loaded.
      </section>
    );
  }

  const gatePassed = report.passed_ci_gate && report.gate_failures.length === 0;
  const latencyBreached = report.p95_tool_latency_ms > activeDataset.latencyGateMs;
  const passDelta = report.tool_pass_rate - report.baseline_pass_rate;
  const passDeltaColor =
    passDelta > 0
      ? "var(--positive)"
      : passDelta < 0
        ? "var(--negative)"
        : "var(--muted)";
  const netDeltaPct =
    summary.p95ToolNetMs !== null &&
    summary.p95BaselineNetMs !== null &&
    summary.p95BaselineNetMs > 0
      ? ((summary.p95ToolNetMs - summary.p95BaselineNetMs) / summary.p95BaselineNetMs) *
        100
      : null;

  return (
    <div className="space-y-5">
      {/* Header Row */}
      <div className="flex flex-col gap-3 border-b border-[var(--border)] pb-3.5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight text-[var(--text)]">
            Eval Benchmarks
          </h1>
          <p className="mt-1 text-[13px] text-[var(--muted)]">
            MCP tool grounding lifted accuracy from{" "}
            {formatPercent(report.baseline_pass_rate)} to{" "}
            {formatPercent(report.tool_pass_rate)} across {summary.totalCases} scenarios
            {netDeltaPct !== null
              ? ` with net p95 latency ${formatMs(summary.p95ToolNetMs ?? 0)} (${netDeltaPct.toFixed(1)}% vs baseline net).`
              : `.`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex border-b border-[var(--border)] text-[13px]"
            role="group"
            aria-label="Evaluation datasets"
          >
            {allDatasets.map((dataset) => {
              const selected = dataset.id === activeDataset.id;
              return (
                <button
                  key={dataset.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelectRun(dataset.id)}
                  className={`-mb-px border-b px-3 py-1.5 font-medium ${
                    selected
                      ? "border-[var(--accent)] text-[var(--text)]"
                      : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
                  }`}
                >
                  {dataset.label}
                </button>
              );
            })}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={(e) => void onReportUpload(e)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="h-8 rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text)] hover:bg-[var(--raised)]"
          >
            Import JSON
          </button>
        </div>
      </div>

      {uploadError && (
        <div
          role="alert"
          className="rounded-[6px] border px-4 py-2.5 text-[13px]"
          style={{
            borderColor: "var(--negative)",
            backgroundColor: "var(--pill-negative-bg)",
            color: "var(--pill-negative-ink)",
          }}
        >
          Upload failed: {uploadError}
        </div>
      )}

      {/* 1px-Divided 5-Cell KPI Strip (Zero Nested Boxes) */}
      <section
        aria-label="Evaluation benchmark metrics"
        className="grid grid-cols-2 divide-y divide-[var(--border)] overflow-hidden rounded-[8px] border border-[var(--border)] bg-[var(--surface)] lg:grid-cols-5 lg:divide-x lg:divide-y-0"
      >
        <div className="p-3.5">
          <div className="flex items-center justify-between text-[13px] text-[var(--muted)]">
            <span>MCP pass rate</span>
            <span className="h-2 w-2 rounded-full bg-[var(--positive)]" />
          </div>
          <div className="num mt-1 text-[20px] font-semibold tracking-tight text-[var(--text)] sm:text-[24px]">
            {formatPercent(report.tool_pass_rate)}
          </div>
          <div className="num mt-0.5 text-[13px]" style={{ color: passDeltaColor }}>
            {formatSignedPp(passDelta)} vs {formatPercent(report.baseline_pass_rate)}
          </div>
        </div>

        <div className="p-3.5">
          <div className="flex items-center justify-between text-[13px] text-[var(--muted)]">
            <span>
              {summary.p95ToolNetMs !== null ? "Net p95 latency" : "Tool p95 latency"}
            </span>
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: "var(--phase-cyan)" }}
            />
          </div>
          <div className="num mt-1 text-[20px] font-semibold tracking-tight text-[var(--text)] sm:text-[24px]">
            {formatMs(
              summary.p95ToolNetMs !== null
                ? summary.p95ToolNetMs
                : report.p95_tool_latency_ms,
            )}
          </div>
          <div className="num mt-0.5 text-[13px] text-[var(--muted)]">
            {summary.p95BaselineNetMs !== null
              ? `vs ${formatMs(summary.p95BaselineNetMs)} base net`
              : `Wall p95 ${formatMs(report.p95_tool_latency_ms)}`}
          </div>
        </div>

        <div className="p-3.5">
          <div className="flex items-center justify-between text-[13px] text-[var(--muted)]">
            <span>Schema validity</span>
            <span className="h-2 w-2 rounded-full bg-[var(--positive)]" />
          </div>
          <div className="num mt-1 text-[20px] font-semibold tracking-tight text-[var(--text)] sm:text-[24px]">
            {formatPercent(report.schema_valid_rate)}
          </div>
          <div className="num mt-0.5 text-[13px] text-[var(--muted)]">
            {summary.schemaValidCount} of {summary.totalCases} valid
          </div>
        </div>

        <div className="p-3.5">
          <div className="flex items-center justify-between text-[13px] text-[var(--muted)]">
            <span>Injection defense</span>
            <span className="h-2 w-2 rounded-full bg-[var(--warning)]" />
          </div>
          <div className="num mt-1 text-[20px] font-semibold tracking-tight text-[var(--text)] sm:text-[24px]">
            {formatPercent(report.injection_block_rate)}
          </div>
          <div className="num mt-0.5 text-[13px] text-[var(--muted)]">
            {summary.adversarialTotal > 0
              ? `${summary.adversarialBlocked} of ${summary.adversarialTotal} blocked`
              : "0 exposed"}
          </div>
        </div>

        <div className="col-span-2 p-3.5 lg:col-span-1">
          <div className="flex items-center justify-between text-[13px] text-[var(--muted)]">
            <span>CI quality gate</span>
            <span
              className="h-2 w-2 rounded-full"
              style={{
                backgroundColor: gatePassed ? "var(--positive)" : "var(--negative)",
              }}
            />
          </div>
          <div
            className="mt-1 text-[20px] font-semibold tracking-tight sm:text-[24px]"
            style={{ color: gatePassed ? "var(--positive)" : "var(--negative)" }}
          >
            {gatePassed ? "Pass" : "Blocked"}
          </div>
          <div className="num mt-0.5 text-[13px] text-[var(--muted)]">
            {gateChecks.filter((c) => c.passed).length} of {gateChecks.length} checks
          </div>
        </div>
      </section>

      {/* Balanced 2/3 + 1/3 Chart & Gate Ledger */}
      <div className="grid grid-cols-1 items-stretch gap-5 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <PairedEvalChart
            rows={mergedRows}
            latencyGateMs={activeDataset.latencyGateMs}
            totalTokens={summary.totalTokens}
            selectedScenarioId={selectedScenarioId}
            onSelectScenario={(scenarioId) => onSelectScenario(scenarioId, false)}
          />
        </div>

        <section className="flex h-full flex-col justify-between rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-5 lg:col-span-4">
          <div>
            <div className="flex items-center justify-between gap-2 border-b border-[var(--rule)] pb-3">
              <div>
                <h2 className="text-[16px] font-semibold text-[var(--text)]">
                  CI gate ledger
                </h2>
                <p className="mt-0.5 text-[13px] text-[var(--muted)]">
                  {activeDataset.modelLabel}
                </p>
              </div>
              <span
                className="rounded-[4px] px-2 py-0.5 text-[13px] font-medium"
                style={{
                  backgroundColor: gatePassed
                    ? "var(--pill-positive-bg)"
                    : "var(--pill-negative-bg)",
                  color: gatePassed
                    ? "var(--pill-positive-ink)"
                    : "var(--pill-negative-ink)",
                }}
              >
                {gatePassed ? "All passed" : "Gate failed"}
              </span>
            </div>

            <div className="mt-2 divide-y divide-[var(--rule)]">
              {gateChecks.map((check) => (
                <div
                  key={check.id}
                  className="flex items-center justify-between gap-2 py-2 text-[13px]"
                >
                  <div>
                    <div className="font-medium text-[var(--text)]">{check.label}</div>
                    <div className="num text-[13px] text-[var(--muted)]">
                      Floor {check.target}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="num font-medium text-[var(--text)]">
                      {check.measured}
                    </div>
                    <div
                      className="text-[13px] font-medium"
                      style={{
                        color: check.passed ? "var(--positive)" : "var(--negative)",
                      }}
                    >
                      {check.passed ? "Pass" : "Fail"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-3 space-y-1.5 border-t border-[var(--rule)] pt-3 text-[13px]">
            {activeDataset.id === "gemini-live" ? (
              <>
                <div className="flex items-center justify-between text-[var(--muted)]">
                  <span>Baseline vs MCP p95</span>
                  <span className="num text-[var(--text)]">
                    {formatMs(summary.p95BaselineMs)} vs{" "}
                    {formatMs(report.p95_tool_latency_ms)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[var(--muted)]">
                  <span>Token budget (MCP / base)</span>
                  <span className="num text-[var(--text)]">
                    {formatInt(summary.totalTokens)} /{" "}
                    {formatInt(summary.baselineTotalTokens)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[var(--muted)]">
                  <span>PR #1 CI regression test</span>
                  <span className="num text-[var(--negative)]">Blocked 0.90 &lt; 0.95</span>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between text-[var(--muted)]">
                  <span>Tool rescues over baseline</span>
                  <span className="num text-[var(--positive)]">
                    {summary.improvedCount} / {summary.totalCases}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[var(--muted)]">
                  <span>Regressions</span>
                  <span className="num text-[var(--text)]">
                    {summary.regressedCount}
                  </span>
                </div>
                {latencyBreached && (
                  <div className="text-[var(--warning)]">
                    Latency ceiling exceeded ({formatMs(activeDataset.latencyGateMs)})
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </div>

      {selectedDetailRow && (
        <div ref={detailPanelRef} id="scenario-detail">
          <ScenarioDetailPanel
            row={selectedDetailRow}
            onClose={onClearScenario}
            onLoadInWorkbench={onLoadInWorkbench}
          />
        </div>
      )}

      {/* Minimalist Scenario Matrix Table */}
      <section className="rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div
            className="flex flex-wrap items-center gap-1 border-b border-[var(--border)] text-[13px]"
            role="tablist"
            aria-label="Scenario filters"
          >
            {(
              [
                ["all", `All (${mergedRows.length})`],
                ["improved", `Tool rescues (${summary.improvedCount})`],
                ["adversarial", `Adversarial (${summary.adversarialTotal})`],
                ["failed", `Failed (${failingCount})`],
              ] as const
            ).map(([tabKey, label]) => {
              const selected = scenarioTab === tabKey;
              return (
                <button
                  key={tabKey}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setScenarioTab(tabKey)}
                  className={`-mb-px border-b px-3 py-2 font-medium ${
                    selected
                      ? "border-[var(--accent)] text-[var(--text)]"
                      : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              id="scenario-search"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search ID, title, or runbook..."
              aria-label="Filter scenarios"
              className="h-8 w-56 rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--text)] placeholder:text-[var(--faint)]"
            />
            <select
              id="scenario-sort"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              aria-label="Sort scenarios"
              className="h-8 rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--text)]"
            >
              <option value="id">Sort: ID</option>
              <option value="latency">Sort: MCP latency</option>
              <option value="tokens">Sort: Tokens</option>
            </select>
          </div>
        </div>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-[13px] text-[var(--muted)]">
                <th className="py-2.5 pr-3 font-medium">Scenario</th>
                <th className="py-2.5 pr-3 font-medium">Outcome</th>
                <th className="py-2.5 pr-3 font-medium">Runbook</th>
                <th className="num py-2.5 pr-3 text-right font-medium">Base</th>
                <th className="num py-2.5 pr-3 text-right font-medium">MCP net</th>
                <th className="num py-2.5 pr-3 text-right font-medium">Calls</th>
                <th className="num py-2.5 pr-3 text-right font-medium">Tokens</th>
                <th className="py-2.5 text-right font-medium">Replay</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--rule)]">
              {filteredScenarios.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-[13px] text-[var(--muted)]">
                    No scenarios match your current filter.
                  </td>
                </tr>
              ) : (
                filteredScenarios.map((row) => {
                  const isSelected = row.scenario_id === selectedScenarioId;
                  const mcpNetMs = Math.max(
                    0,
                    row.tool_latency_ms - (row.tool_pacing_wait_ms ?? 0),
                  );
                  return (
                    <tr
                      key={row.scenario_id}
                      onClick={() => onSelectScenario(row.scenario_id, true)}
                      className={`cursor-pointer ${
                        isSelected ? "bg-[var(--active)]" : "hover:bg-[var(--raised)]"
                      }`}
                    >
                      <td className="py-2.5 pr-3">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectScenario(row.scenario_id, true);
                          }}
                          aria-expanded={isSelected}
                          className="flex items-center gap-2 text-left"
                        >
                          <code className="text-[13px] font-medium text-[var(--accent)]">
                            {row.scenario_id}
                          </code>
                          <span className="font-medium text-[var(--text)]">{row.title}</span>
                        </button>
                      </td>
                      <td className="py-2.5 pr-3">
                        <span
                          className="inline-flex rounded-[4px] px-2 py-0.5 text-[13px] font-medium"
                          style={{
                            backgroundColor: row.tool_passed
                              ? "var(--pill-positive-bg)"
                              : "var(--pill-negative-bg)",
                            color: row.tool_passed
                              ? "var(--pill-positive-ink)"
                              : "var(--pill-negative-ink)",
                          }}
                        >
                          {row.tool_passed ? "MCP pass" : "MCP fail"}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3">
                        {row.expected_runbook ? (
                          <code className="text-[13px] text-[var(--text)]">
                            {row.expected_runbook}
                          </code>
                        ) : (
                          <span className="text-[var(--muted)]">-</span>
                        )}
                      </td>
                      <td className="num py-2.5 pr-3 text-right text-[var(--muted)]">
                        {row.baseline_passed ? "Pass" : "Fail"}
                      </td>
                      <td className="num py-2.5 pr-3 text-right text-[var(--text)]">
                        {formatMs(mcpNetMs)}
                      </td>
                      <td className="num py-2.5 pr-3 text-right text-[var(--muted)]">
                        {row.tool_calls ?? 0}
                      </td>
                      <td className="num py-2.5 pr-3 text-right text-[var(--muted)]">
                        {row.total_tokens > 0 ? formatInt(row.total_tokens) : "0"}
                      </td>
                      <td className="py-2.5 text-right">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onLoadInWorkbench(row);
                          }}
                          className="rounded-[4px] border border-[var(--control)] bg-[var(--raised)] px-2 py-1 text-[13px] font-medium text-[var(--text)] hover:bg-[var(--active)]"
                        >
                          Test
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
