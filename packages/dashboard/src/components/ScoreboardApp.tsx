"use client";

import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { AgentGateMark } from "@/components/AgentGateMark";
import { PairedEvalChart } from "@/components/PairedEvalChart";
import { ScenarioDetailPanel } from "@/components/ScenarioDetailPanel";
import {
  buildGateChecks,
  buildRunbookBreakdown,
  computeSummaryMetrics,
  formatInt,
  formatMs,
  formatPercent,
  formatSignedPp,
  mergeCases,
  parseUploadedReport,
  type EvalScenario,
  type MergedCaseRow,
  type RunDataset,
} from "@/lib/evalData";

interface ScoreboardAppProps {
  readonly datasets: readonly RunDataset[];
  readonly scenarios: readonly EvalScenario[];
}

type NavView = "overview" | "scenarios" | "security";
type ScenarioTab = "all" | "failed" | "improved" | "adversarial";
type SortOption = "id" | "latency" | "tokens";

export function ScoreboardApp({ datasets, scenarios }: ScoreboardAppProps) {
  const [uploadedDatasets, setUploadedDatasets] = useState<readonly RunDataset[]>([]);
  const allDatasets = useMemo(
    () => [...datasets, ...uploadedDatasets],
    [datasets, uploadedDatasets],
  );

  const [selectedRunId, setSelectedRunId] = useState<string>(
    datasets[0]?.id ?? "gemini-live",
  );
  const [activeView, setActiveView] = useState<NavView>("overview");
  const [scenarioTab, setScenarioTab] = useState<ScenarioTab>("all");
  const [sortBy, setSortBy] = useState<SortOption>("id");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeDataset =
    allDatasets.find((item) => item.id === selectedRunId) ?? allDatasets[0];

  const mergedRows = useMemo(
    () => (activeDataset ? mergeCases(activeDataset.report, scenarios) : []),
    [activeDataset, scenarios],
  );

  const summary = useMemo(
    () =>
      activeDataset
        ? computeSummaryMetrics(activeDataset.report, mergedRows)
        : null,
    [activeDataset, mergedRows],
  );

  const gateChecks = useMemo(
    () =>
      activeDataset
        ? buildGateChecks(activeDataset.report, activeDataset)
        : [],
    [activeDataset],
  );

  const runbookBreakdown = useMemo(
    () => buildRunbookBreakdown(mergedRows),
    [mergedRows],
  );

  const failingCount = mergedRows.filter((row) => !row.tool_passed).length;

  const priorityRows = useMemo(() => {
    const ordered = [...mergedRows].sort((a, b) => {
      if (a.tool_passed !== b.tool_passed) {
        return a.tool_passed ? 1 : -1;
      }
      return b.tool_latency_ms - a.tool_latency_ms;
    });
    return ordered.slice(0, 5);
  }, [mergedRows]);

  const filteredScenarios = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = mergedRows.filter((row) => {
      if (scenarioTab === "failed" && row.tool_passed) {
        return false;
      }
      if (scenarioTab === "improved" && !(!row.baseline_passed && row.tool_passed)) {
        return false;
      }
      if (scenarioTab === "adversarial" && !row.is_adversarial_injection) {
        return false;
      }
      if (!q) {
        return true;
      }
      return (
        row.scenario_id.toLowerCase().includes(q) ||
        row.title.toLowerCase().includes(q) ||
        (row.expected_runbook ?? "").toLowerCase().includes(q)
      );
    });

    return [...filtered].sort((a, b) => {
      if (sortBy === "latency") {
        return b.tool_latency_ms - a.tool_latency_ms;
      }
      if (sortBy === "tokens") {
        return b.total_tokens - a.total_tokens;
      }
      return a.scenario_id.localeCompare(b.scenario_id);
    });
  }, [mergedRows, scenarioTab, searchQuery, sortBy]);

  const adversarialRows = useMemo(
    () => mergedRows.filter((row) => row.is_adversarial_injection),
    [mergedRows],
  );

  const selectedDetailRow: MergedCaseRow | null = useMemo(
    () => mergedRows.find((row) => row.scenario_id === selectedScenarioId) ?? null,
    [mergedRows, selectedScenarioId],
  );

  function handleSelectRun(runId: string) {
    setSelectedRunId(runId);
    setSelectedScenarioId(null);
    setMobileMenuOpen(false);
  }

  function handleNavigate(view: NavView, tab?: ScenarioTab) {
    setActiveView(view);
    if (tab) {
      setScenarioTab(tab);
    }
    setMobileMenuOpen(false);
  }

  async function handleReportUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    try {
      const content = await file.text();
      const report = parseUploadedReport(content);
      const id = `uploaded-${Date.now()}`;
      const uploaded: RunDataset = {
        id,
        label: file.name.replace(/\.json$/i, ""),
        subtitle: "Uploaded EvalSuiteReport JSON artifact",
        modelLabel: "Custom JSON artifact",
        latencyGateMs: 20000,
        minToolPassRate: 0.85,
        minDelta: 0.0,
        report,
      };
      setUploadedDatasets((prev) => [...prev, uploaded]);
      setSelectedRunId(id);
      setSelectedScenarioId(null);
      setUploadError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unable to read uploaded JSON report.";
      setUploadError(msg);
    }
  }

  if (!activeDataset || !summary) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <h1 className="text-[22px] font-semibold text-[var(--text)]">AgentGate Eval Scoreboard</h1>
        <p className="mt-2 text-[14px] text-[var(--muted)]">
          No evaluation datasets are currently loaded.
        </p>
      </main>
    );
  }

  const report = activeDataset.report;
  const gatePassed = report.passed_ci_gate;
  const latencyBreached = report.p95_tool_latency_ms > activeDataset.latencyGateMs;

  const findingText = gatePassed
    ? `MCP tools raised accuracy by ${formatSignedPp(report.tool_pass_rate - report.baseline_pass_rate)} to ${formatPercent(report.tool_pass_rate)} (${summary.toolPassedCount}/${summary.totalCases}) with ${summary.adversarialBlocked}/${summary.adversarialTotal} injections blocked at ${formatMs(report.p95_tool_latency_ms)} p95.`
    : `MCP tools lifted accuracy from ${formatPercent(report.baseline_pass_rate)} to ${formatPercent(report.tool_pass_rate)} (${formatSignedPp(report.tool_pass_rate - report.baseline_pass_rate)}) with ${summary.adversarialBlocked}/${summary.adversarialTotal} injections blocked, while p95 latency (${formatMs(report.p95_tool_latency_ms)}) exceeded the ${formatMs(activeDataset.latencyGateMs)} gate.`;

  const sidebarContent = (
    <div className="flex h-full flex-col justify-between px-3 py-4">
      <div>
        <div className="flex items-center gap-2.5 px-2.5 pb-4">
          <AgentGateMark />
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold text-[var(--text)]">AgentGate</div>
            <div className="truncate text-[13px] text-[var(--muted)]">
              Eval gate ({summary.totalCases} scenarios)
            </div>
          </div>
        </div>

        <nav aria-label="Primary views" className="mt-2 space-y-1">
          <button
            type="button"
            onClick={() => handleNavigate("overview")}
            className={`flex h-9 w-full items-center justify-between rounded-[8px] px-2.5 text-left text-[14px] transition-colors ${
              activeView === "overview"
                ? "bg-[var(--active)] font-medium text-[var(--text)]"
                : "text-[var(--muted)] hover:bg-[var(--raised)] hover:text-[var(--text)]"
            }`}
          >
            <span className="flex items-center gap-2.5">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
              </svg>
              Overview
            </span>
          </button>

          <button
            type="button"
            onClick={() => handleNavigate("scenarios")}
            className={`flex h-9 w-full items-center justify-between rounded-[8px] px-2.5 text-left text-[14px] transition-colors ${
              activeView === "scenarios"
                ? "bg-[var(--active)] font-medium text-[var(--text)]"
                : "text-[var(--muted)] hover:bg-[var(--raised)] hover:text-[var(--text)]"
            }`}
          >
            <span className="flex items-center gap-2.5">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              Scenarios
            </span>
            {failingCount > 0 && (
              <span
                className="num shrink-0 whitespace-nowrap rounded-[4px] px-1.5 py-0.5 text-[12px] font-medium"
                style={{
                  backgroundColor: "var(--pill-negative-bg)",
                  color: "var(--pill-negative-ink)",
                }}
              >
                {failingCount} fail
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => handleNavigate("security")}
            className={`flex h-9 w-full items-center justify-between rounded-[8px] px-2.5 text-left text-[14px] transition-colors ${
              activeView === "security"
                ? "bg-[var(--active)] font-medium text-[var(--text)]"
                : "text-[var(--muted)] hover:bg-[var(--raised)] hover:text-[var(--text)]"
            }`}
          >
            <span className="flex items-center gap-2.5">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 3l7 3v5c0 4.5-3 8.4-7 10-4-1.6-7-5.5-7-10V6l7-3z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
              </svg>
              Runbooks & security
            </span>
          </button>
        </nav>

        <div className="mt-6 px-2.5">
          <div className="text-[13px] font-medium text-[var(--muted)]">Evaluation runs</div>
          <div className="mt-2 space-y-1">
            {allDatasets.map((dataset) => {
              const isActive = dataset.id === activeDataset.id;
              return (
                <button
                  key={dataset.id}
                  type="button"
                  onClick={() => handleSelectRun(dataset.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-[8px] px-2.5 py-2 text-left text-[13px] transition-colors ${
                    isActive
                      ? "border border-[var(--border)] bg-[var(--surface)] font-medium text-[var(--text)]"
                      : "text-[var(--muted)] hover:bg-[var(--raised)] hover:text-[var(--text)]"
                  }`}
                >
                  <span className="truncate">{dataset.label}</span>
                  <span
                    className="num shrink-0 whitespace-nowrap text-[12px] font-medium"
                    style={{
                      color: dataset.report.passed_ci_gate
                        ? "var(--positive)"
                        : "var(--negative)",
                    }}
                  >
                    {formatPercent(dataset.report.tool_pass_rate)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="px-2.5 pt-4 text-[13px] text-[var(--muted)]">
        <div className="font-medium text-[var(--text)]">Source artifacts</div>
        <div className="mt-0.5 truncate">{activeDataset.modelLabel}</div>
        <div className="mt-1">
          <a
            href="https://github.com/Hirosus/AgentGate"
            target="_blank"
            rel="noreferrer"
            className="text-[var(--accent)] hover:underline"
          >
            Hirosus/AgentGate
          </a>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-dvh bg-[var(--ground)] text-[var(--text)]">
      <aside className="hidden w-[252px] shrink-0 lg:block">{sidebarContent}</aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 px-4 lg:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
              className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-2.5 text-[13px] font-medium text-[var(--text)] lg:hidden"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              Menu
            </button>

            <label htmlFor="global-scenario-search" className="sr-only">
              Search scenarios by ID or runbook
            </label>
            <input
              id="global-scenario-search"
              type="search"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                if (e.target.value.trim() && activeView !== "scenarios") {
                  setActiveView("scenarios");
                }
              }}
              placeholder="Search scenarios or runbooks (e.g. inc-004, rb-hmac)"
              className="h-8 w-full max-w-[360px] rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-3 text-[13px] text-[var(--text)] placeholder:text-[var(--faint)]"
            />
          </div>

          <div className="flex shrink-0 items-center gap-2.5">
            <span className="hidden text-[13px] text-[var(--muted)] sm:inline">
              {activeDataset.label}
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={handleReportUpload}
              className="hidden"
              aria-label="Upload EvalSuiteReport JSON file"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="h-8 shrink-0 whitespace-nowrap rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--raised)]"
            >
              Load report JSON
            </button>
          </div>
        </header>

        <main className="flex-1 bg-[var(--surface)] p-4 sm:p-6 lg:mb-2 lg:mr-2 lg:rounded-[16px] lg:border lg:border-[var(--border)]">
          {uploadError && (
            <div
              role="alert"
              className="mb-4 flex items-center justify-between gap-3 rounded-[8px] border border-[#fde68a] bg-[var(--pill-warning-bg)] px-4 py-2.5 text-[13px] text-[var(--pill-warning-ink)]"
            >
              <span>Could not load uploaded report: {uploadError}</span>
              <button
                type="button"
                onClick={() => setUploadError(null)}
                className="font-medium underline"
              >
                Dismiss
              </button>
            </div>
          )}

          {activeView === "overview" && (
            <div className="space-y-6">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0 max-w-2xl">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text)]">
                      Eval gate overview
                    </h1>
                    <span
                      className="inline-flex shrink-0 items-center rounded-[4px] px-2 py-0.5 text-[12px] font-medium"
                      style={{
                        backgroundColor: gatePassed
                          ? "var(--pill-positive-bg)"
                          : "var(--pill-negative-bg)",
                        color: gatePassed
                          ? "var(--pill-positive-ink)"
                          : "var(--pill-negative-ink)",
                      }}
                    >
                      {gatePassed ? "CI gate passed" : "CI gate failed"}
                    </span>
                  </div>
                  <p className="mt-1 text-[14px] text-[var(--muted)]">{findingText}</p>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {allDatasets.map((dataset) => {
                    const active = dataset.id === activeDataset.id;
                    return (
                      <button
                        key={dataset.id}
                        type="button"
                        onClick={() => handleSelectRun(dataset.id)}
                        className={`h-8 shrink-0 whitespace-nowrap rounded-[6px] px-3 text-[13px] font-medium transition-colors ${
                          active
                            ? "bg-[var(--primary)] text-white"
                            : "border border-[var(--control)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--raised)]"
                        }`}
                      >
                        {dataset.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <section
                aria-label="Key evaluation metrics"
                className="grid grid-cols-2 rounded-[8px] border border-[var(--border)] bg-[var(--surface)] lg:grid-cols-5"
              >
                <div className="col-span-2 border-b border-[var(--rule)] p-4 lg:col-span-1 lg:border-b-0 lg:border-r">
                  <div className="text-[13px] font-medium text-[var(--muted)]">MCP pass rate</div>
                  <div className="num mt-1 text-[32px] font-normal leading-tight text-[var(--text)]">
                    {formatPercent(report.tool_pass_rate)}
                  </div>
                  <div
                    className="num mt-1 text-[13px] font-medium"
                    style={{ color: "var(--positive)" }}
                  >
                    {formatSignedPp(report.tool_pass_rate - report.baseline_pass_rate)} vs baseline
                  </div>
                </div>

                <div className="border-b border-r border-[var(--rule)] p-4 lg:border-b-0">
                  <div className="text-[13px] font-medium text-[var(--muted)]">
                    Baseline pass rate
                  </div>
                  <div className="num mt-1 text-[26px] font-normal leading-tight text-[var(--text)]">
                    {formatPercent(report.baseline_pass_rate)}
                  </div>
                  <div className="num mt-1 text-[13px] text-[var(--muted)]">
                    {summary.baselinePassedCount} / {summary.totalCases} no-tool
                  </div>
                </div>

                <div className="border-b border-[var(--rule)] p-4 lg:border-b-0 lg:border-r">
                  <div className="text-[13px] font-medium text-[var(--muted)]">
                    Schema validity
                  </div>
                  <div className="num mt-1 text-[26px] font-normal leading-tight text-[var(--text)]">
                    {formatPercent(report.schema_valid_rate)}
                  </div>
                  <div className="num mt-1 text-[13px] text-[var(--muted)]">
                    {summary.schemaValidCount} / {summary.totalCases} strict JSON
                  </div>
                </div>

                <div className="border-r border-[var(--rule)] p-4">
                  <div className="text-[13px] font-medium text-[var(--muted)]">
                    Injection resistance
                  </div>
                  <div className="num mt-1 text-[26px] font-normal leading-tight text-[var(--text)]">
                    {formatPercent(report.injection_block_rate)}
                  </div>
                  <div className="num mt-1 text-[13px] text-[var(--muted)]">
                    {summary.adversarialBlocked} / {summary.adversarialTotal} blocked
                  </div>
                </div>

                <div className="p-4">
                  <div className="text-[13px] font-medium text-[var(--muted)]">
                    Tool p95 latency
                  </div>
                  <div
                    className="num mt-1 text-[26px] font-normal leading-tight"
                    style={{
                      color: latencyBreached ? "var(--negative)" : "var(--text)",
                    }}
                  >
                    {formatMs(report.p95_tool_latency_ms)}
                  </div>
                  <div className="num mt-1 text-[13px] text-[var(--muted)]">
                    Baseline p95 {formatMs(summary.p95BaselineMs)}
                  </div>
                </div>
              </section>

              <div className="grid grid-cols-1 items-stretch gap-6 xl:grid-cols-12">
                <div className="xl:col-span-8">
                  <PairedEvalChart
                    rows={mergedRows}
                    latencyGateMs={activeDataset.latencyGateMs}
                    totalTokens={summary.totalTokens}
                    selectedScenarioId={selectedScenarioId}
                    onSelectScenario={(id) =>
                      setSelectedScenarioId((prev) => (prev === id ? null : id))
                    }
                  />
                </div>

                <section className="flex flex-col justify-between rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-5 xl:col-span-4">
                  <div>
                    <h2 className="text-[16px] font-semibold text-[var(--text)]">
                      CI gate checks
                    </h2>
                    <p className="mt-0.5 text-[13px] text-[var(--muted)]">
                      {activeDataset.subtitle}
                    </p>

                    <div className="mt-4 divide-y divide-[var(--rule)]">
                      {gateChecks.map((check) => (
                        <div
                          key={check.id}
                          className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                        >
                          <div className="min-w-0">
                            <div className="text-[13px] font-medium text-[var(--text)]">
                              {check.label}
                            </div>
                            <div className="num text-[13px] text-[var(--muted)]">
                              Target {check.target}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <span className="num text-[13px] font-medium text-[var(--text)]">
                              {check.measured}
                            </span>
                            <span
                              className="inline-flex items-center rounded-[4px] px-2 py-0.5 text-[12px] font-medium"
                              style={{
                                backgroundColor: check.passed
                                  ? "var(--pill-positive-bg)"
                                  : "var(--pill-negative-bg)",
                                color: check.passed
                                  ? "var(--pill-positive-ink)"
                                  : "var(--pill-negative-ink)",
                              }}
                            >
                              {check.passed ? "Pass" : "Fail"}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-5 flex items-center justify-between gap-3 border-t border-[var(--rule)] pt-4">
                    <span className="num text-[13px] text-[var(--muted)]">
                      {summary.totalTokens > 0
                        ? `${formatInt(summary.totalTokens)} total tool tokens`
                        : "Deterministic CI run (0 LLM tokens)"}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        handleNavigate("scenarios", failingCount > 0 ? "failed" : "all")
                      }
                      className="h-8 shrink-0 whitespace-nowrap rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--raised)]"
                    >
                      {failingCount > 0
                        ? `Inspect ${failingCount} failed`
                        : "View all scenarios"}
                    </button>
                  </div>
                </section>
              </div>

              <section>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-[16px] font-semibold text-[var(--text)]">
                      Priority scenarios
                    </h2>
                    <p className="text-[13px] text-[var(--muted)]">
                      Failing cases and slowest tail runs from {activeDataset.label}. Click a row to inspect payload and output metrics.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleNavigate("scenarios", "all")}
                    className="h-8 shrink-0 whitespace-nowrap rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--raised)]"
                  >
                    View all {summary.totalCases}
                  </button>
                </div>

                <ScenarioTable
                  rows={priorityRows}
                  selectedId={selectedScenarioId}
                  onSelect={(id) =>
                    setSelectedScenarioId((prev) => (prev === id ? null : id))
                  }
                />
              </section>

              {selectedDetailRow && (
                <ScenarioDetailPanel
                  row={selectedDetailRow}
                  onClose={() => setSelectedScenarioId(null)}
                />
              )}
            </div>
          )}

          {activeView === "scenarios" && (
            <div className="space-y-5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text)]">
                    Benchmark scenarios
                  </h1>
                  <p className="mt-0.5 text-[13px] text-[var(--muted)]">
                    Paired baseline vs. MCP-assisted triage outcomes for {activeDataset.label}.
                  </p>
                </div>
                <span className="num text-[13px] text-[var(--muted)]">
                  {filteredScenarios.length} of {summary.totalCases} scenarios
                </span>
              </div>

              <div className="border-b border-[var(--border)]">
                <div className="-mb-px flex flex-wrap gap-6" role="tablist" aria-label="Scenario filters">
                  {(
                    [
                      ["all", `All (${summary.totalCases})`],
                      ["failed", `Failed (${failingCount})`],
                      ["improved", `MCP improved (${summary.improvedCount})`],
                      ["adversarial", `Adversarial (${summary.adversarialTotal})`],
                    ] as const
                  ).map(([tabKey, tabLabel]) => {
                    const active = scenarioTab === tabKey;
                    return (
                      <button
                        key={tabKey}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => setScenarioTab(tabKey)}
                        className={`border-b-2 pb-2.5 text-[14px] font-medium transition-colors ${
                          active
                            ? "border-[var(--accent)] text-[var(--text)]"
                            : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
                        }`}
                      >
                        {tabLabel}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-1 items-center gap-2">
                  <label htmlFor="table-filter-input" className="sr-only">
                    Filter scenarios
                  </label>
                  <input
                    id="table-filter-input"
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter by ID, service, or runbook..."
                    className="h-8 w-full max-w-[300px] rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-3 text-[13px] text-[var(--text)] placeholder:text-[var(--faint)]"
                  />
                  {(searchQuery.trim() !== "" || scenarioTab !== "all") && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchQuery("");
                        setScenarioTab("all");
                      }}
                      className="h-8 shrink-0 rounded-[6px] px-2.5 text-[12px] font-medium text-[var(--accent)] hover:bg-[var(--raised)]"
                    >
                      Reset
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <label htmlFor="sort-select" className="text-[12px] text-[var(--muted)]">
                    Sort
                  </label>
                  <select
                    id="sort-select"
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as SortOption)}
                    className="h-8 rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--text)]"
                  >
                    <option value="id">Scenario ID</option>
                    <option value="latency">Slowest tool latency</option>
                    <option value="tokens">Highest token spend</option>
                  </select>
                </div>
              </div>

              {filteredScenarios.length === 0 ? (
                <div className="rounded-[8px] border border-dashed border-[var(--control)] bg-[var(--raised)] px-4 py-8 text-center">
                  <p className="text-[14px] text-[var(--text)]">
                    No scenarios match the current filter.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery("");
                      setScenarioTab("all");
                    }}
                    className="mt-3 h-8 rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-3 text-[12px] font-medium text-[var(--text)]"
                  >
                    Reset filters
                  </button>
                </div>
              ) : (
                <ScenarioTable
                  rows={filteredScenarios}
                  selectedId={selectedScenarioId}
                  onSelect={(id) =>
                    setSelectedScenarioId((prev) => (prev === id ? null : id))
                  }
                />
              )}

              {selectedDetailRow && (
                <ScenarioDetailPanel
                  row={selectedDetailRow}
                  onClose={() => setSelectedScenarioId(null)}
                />
              )}
            </div>
          )}

          {activeView === "security" && (
            <div className="space-y-6">
              <div>
                <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text)]">
                  Runbook coverage and injection audit
                </h1>
                <p className="mt-1 text-[14px] text-[var(--muted)]">
                  Verification coverage across all 8 read-only MCP runbooks and 5 adversarial prompt-injection probes for {activeDataset.label}.
                </p>
              </div>

              <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-12">
                <section className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-5 xl:col-span-6">
                  <h2 className="text-[16px] font-semibold text-[var(--text)]">
                    Verified MCP runbooks
                  </h2>
                  <p className="mt-0.5 text-[12px] text-[var(--muted)]">
                    Pass ratio and mean MCP tool latency grouped by expected runbook ID.
                  </p>

                  <div className="mt-4 divide-y divide-[var(--rule)]">
                    {runbookBreakdown.map((item) => {
                      const ratio = item.total > 0 ? item.toolPassed / item.total : 0;
                      const allPass = item.toolPassed === item.total;
                      return (
                        <div key={item.runbookId} className="py-3 first:pt-0 last:pb-0">
                          <div className="flex items-center justify-between gap-3">
                            <code className="text-[13px] font-medium text-[var(--text)]">
                              {item.runbookId}
                            </code>
                            <div className="flex items-center gap-3 text-[12px]">
                              <span className="num text-[var(--muted)]">
                                avg {formatMs(item.avgToolMs)}
                              </span>
                              <span
                                className="num font-medium"
                                style={{
                                  color: allPass ? "var(--positive)" : "var(--negative)",
                                }}
                              >
                                {item.toolPassed} / {item.total}
                              </span>
                            </div>
                          </div>
                          <div className="mt-2 h-1 w-full overflow-hidden rounded-[2px] bg-[var(--rule)]">
                            <div
                              className="h-full"
                              style={{
                                width: `${ratio * 100}%`,
                                backgroundColor: allPass ? "var(--chart-1)" : "var(--negative)",
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-5 xl:col-span-6">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h2 className="text-[16px] font-semibold text-[var(--text)]">
                        Prompt-injection resistance audit
                      </h2>
                      <p className="mt-0.5 text-[12px] text-[var(--muted)]">
                        Adversarial overrides inside alert payloads and untrusted MCP log telemetry.
                      </p>
                    </div>
                    <span
                      className="num shrink-0 rounded-[4px] px-2 py-0.5 text-[12px] font-medium"
                      style={{
                        backgroundColor:
                          summary.adversarialBlocked === summary.adversarialTotal
                            ? "var(--pill-positive-bg)"
                            : "var(--pill-negative-bg)",
                        color:
                          summary.adversarialBlocked === summary.adversarialTotal
                            ? "var(--pill-positive-ink)"
                            : "var(--pill-negative-ink)",
                      }}
                    >
                      {summary.adversarialBlocked} / {summary.adversarialTotal} blocked
                    </span>
                  </div>

                  <div className="mt-4 divide-y divide-[var(--rule)]">
                    {adversarialRows.map((row) => (
                      <div key={row.scenario_id} className="py-3 first:pt-0 last:pb-0">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <code className="shrink-0 text-[12px] font-medium text-[var(--text)]">
                              {row.scenario_id}
                            </code>
                            <span className="truncate text-[13px] font-medium text-[var(--text)]">
                              {row.title}
                            </span>
                          </div>
                          <span
                            className="shrink-0 rounded-[4px] px-2 py-0.5 text-[11px] font-medium"
                            style={{
                              backgroundColor: row.injection_blocked
                                ? "var(--pill-positive-bg)"
                                : "var(--pill-negative-bg)",
                              color: row.injection_blocked
                                ? "var(--pill-positive-ink)"
                                : "var(--pill-negative-ink)",
                            }}
                          >
                            {row.injection_blocked ? "Blocked" : "Bypassed"}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-[12px] text-[var(--muted)]">
                          {row.payload_text}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </div>
          )}
        </main>
      </div>

      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation menu">
          <div
            className="fixed inset-0 bg-black/30"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <div className="relative z-10 flex w-[264px] max-w-[85vw] flex-col bg-[var(--ground)]">
            <div className="flex h-12 items-center justify-end px-3">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="h-8 rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-2.5 text-[12px] font-medium text-[var(--text)]"
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">{sidebarContent}</div>
          </div>
        </div>
      )}
    </div>
  );
}

interface ScenarioTableProps {
  readonly rows: readonly MergedCaseRow[];
  readonly selectedId: string | null;
  readonly onSelect: (scenarioId: string) => void;
}

function ScenarioTable({ rows, selectedId, onSelect }: ScenarioTableProps) {
  return (
    <div className="mt-3">
      <div className="divide-y divide-[var(--rule)] border-t border-b border-[var(--border)] sm:hidden">
        {rows.map((row) => {
          const isSelected = row.scenario_id === selectedId;
          return (
            <button
              key={row.scenario_id}
              type="button"
              onClick={() => onSelect(row.scenario_id)}
              className={`block w-full px-2 py-3 text-left transition-colors ${
                isSelected ? "bg-[var(--active)]" : "hover:bg-[var(--raised)]"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <code className="shrink-0 text-[12px] font-medium text-[var(--text)]">
                    {row.scenario_id}
                  </code>
                  <span className="truncate text-[13px] font-medium text-[var(--text)]">
                    {row.title}
                  </span>
                </span>
                <span
                  className="shrink-0 rounded-[4px] px-2 py-0.5 text-[11px] font-medium"
                  style={{
                    backgroundColor: row.tool_passed
                      ? "var(--pill-positive-bg)"
                      : "var(--pill-negative-bg)",
                    color: row.tool_passed
                      ? "var(--pill-positive-ink)"
                      : "var(--pill-negative-ink)",
                  }}
                >
                  {row.tool_passed ? "Pass" : "Fail"}
                </span>
              </div>
              <div className="num mt-1 flex flex-wrap gap-x-3 text-[13px] text-[var(--muted)]">
                <span>MCP {formatMs(row.tool_latency_ms)}</span>
                <span>Base {row.baseline_passed ? "Pass" : "Fail"}</span>
                {row.total_tokens > 0 && <span>{formatInt(row.total_tokens)} tok</span>}
              </div>
            </button>
          );
        })}
      </div>

      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full border-collapse text-left text-[13px]">
          <thead>
            <tr className="h-9 text-[13px] font-normal text-[var(--muted)]">
              <th className="py-2 pr-4 font-normal">Scenario</th>
              <th className="py-2 pr-4 font-normal">Runbook</th>
              <th className="py-2 pr-4 text-right font-normal">Baseline</th>
              <th className="py-2 pr-4 text-right font-normal">MCP latency</th>
              <th className="py-2 pr-4 text-right font-normal">Tokens</th>
              <th className="py-2 text-right font-normal">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--rule)] border-t border-[var(--border)]">
            {rows.map((row) => {
              const isSelected = row.scenario_id === selectedId;
              return (
                <tr
                  key={row.scenario_id}
                  onClick={() => onSelect(row.scenario_id)}
                  className={`h-12 cursor-pointer transition-colors ${
                    isSelected ? "bg-[var(--active)]" : "hover:bg-[var(--raised)]"
                  }`}
                >
                  <td className="py-2.5 pr-4">
                    <div className="flex items-center gap-2.5">
                      <code className="shrink-0 text-[13px] font-medium text-[var(--text)]">
                        {row.scenario_id}
                      </code>
                      <span className="truncate font-medium text-[var(--text)]">
                        {row.title}
                      </span>
                      {row.is_adversarial_injection && (
                        <span
                          className="shrink-0 rounded-[4px] px-1.5 py-0.5 text-[12px] font-medium"
                          style={{
                            backgroundColor: "var(--pill-warning-bg)",
                            color: "var(--pill-warning-ink)",
                          }}
                        >
                          Injection
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2.5 pr-4">
                    {row.expected_runbook ? (
                      <code className="text-[13px] text-[var(--muted)]">
                        {row.expected_runbook}
                      </code>
                    ) : (
                      <span className="text-[var(--muted)]">-</span>
                    )}
                  </td>
                  <td className="num py-2.5 pr-4 text-right text-[var(--muted)]">
                    {row.baseline_passed ? "Pass" : "Fail"} ({formatMs(row.baseline_latency_ms)})
                  </td>
                  <td className="num py-2.5 pr-4 text-right font-medium text-[var(--text)]">
                    {formatMs(row.tool_latency_ms)}
                  </td>
                  <td className="num py-2.5 pr-4 text-right text-[var(--muted)]">
                    {row.total_tokens > 0 ? formatInt(row.total_tokens) : "0"}
                  </td>
                  <td className="py-2.5 text-right">
                    <span
                      className="inline-flex items-center rounded-[4px] px-2 py-0.5 text-[12px] font-medium"
                      style={{
                        backgroundColor: row.tool_passed
                          ? "var(--pill-positive-bg)"
                          : "var(--pill-negative-bg)",
                        color: row.tool_passed
                          ? "var(--pill-positive-ink)"
                          : "var(--pill-negative-ink)",
                      }}
                    >
                      {row.tool_passed ? "Pass" : "Fail"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
