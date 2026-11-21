"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { AgentGateMark } from "@/components/AgentGateMark";
import { CommandPalette } from "@/components/CommandPalette";
import {
  LiveTriageWorkbench,
  type LiveTriagePresetRequest,
} from "@/components/LiveTriageWorkbench";
import { PairedEvalChart } from "@/components/PairedEvalChart";
import { RunbookDrawer } from "@/components/RunbookDrawer";
import { ScenarioDetailPanel } from "@/components/ScenarioDetailPanel";
import {
  buildGateChecks,
  buildRunbookBreakdown,
  compareScenarioIds,
  computeSummaryMetrics,
  formatInt,
  formatMs,
  formatPercent,
  formatSignedPp,
  mergeCases,
  parseUploadedReport,
  type EvalScenario,
  type McpCatalog,
  type MergedCaseRow,
  type RunDataset,
  type RunbookSummary,
} from "@/lib/evalData";

interface ScoreboardAppProps {
  readonly datasets: readonly RunDataset[];
  readonly scenarios: readonly EvalScenario[];
  readonly catalog: McpCatalog;
}

type NavView = "triage" | "benchmarks" | "security";
type ScenarioTab = "all" | "failed" | "improved" | "adversarial";
type SortOption = "id" | "latency" | "tokens";
type ThemeMode = "dark" | "light";

const THEME_STORAGE_KEY = "agentgate-theme";
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export function ScoreboardApp({ datasets, scenarios, catalog }: ScoreboardAppProps) {
  const [uploadedDatasets, setUploadedDatasets] = useState<readonly RunDataset[]>([]);
  const allDatasets = useMemo(
    () => [...datasets, ...uploadedDatasets],
    [datasets, uploadedDatasets],
  );

  const [activeView, setActiveView] = useState<NavView>("triage");
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [selectedRunId, setSelectedRunId] = useState<string>(
    datasets[0]?.id ?? "gemini-live",
  );
  const [scenarioTab, setScenarioTab] = useState<ScenarioTab>("all");
  const [sortBy, setSortBy] = useState<SortOption>("id");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [activeRunbookId, setActiveRunbookId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);
  const [presetRequest, setPresetRequest] = useState<LiveTriagePresetRequest | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const detailPanelRef = useRef<HTMLDivElement>(null);
  const shouldScrollToDetailRef = useRef<boolean>(false);
  const presetNonceRef = useRef<number>(0);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      const attr = document.documentElement.getAttribute("data-theme");
      const resolved: ThemeMode =
        stored === "light" || stored === "dark"
          ? stored
          : attr === "light" || attr === "dark"
            ? attr
            : "dark";
      document.documentElement.setAttribute("data-theme", resolved);
      setTheme(resolved);
    } catch {
      const attr = document.documentElement.getAttribute("data-theme");
      if (attr === "light" || attr === "dark") {
        setTheme(attr);
      }
    }
  }, []);

  useEffect(() => {
    function handleGlobalKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, []);

  useEffect(() => {
    if (
      activeView !== "benchmarks" ||
      !selectedScenarioId ||
      !shouldScrollToDetailRef.current
    ) {
      return;
    }
    shouldScrollToDetailRef.current = false;
    const raf = window.requestAnimationFrame(() => {
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      detailPanelRef.current?.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "nearest",
      });
    });
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [activeView, selectedScenarioId]);

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

  const catalogRunbooks = useMemo(
    () =>
      Object.entries(catalog.runbooks)
        .filter(([symptomTag]) => Object.hasOwn(catalog.runbooks, symptomTag))
        .map(([symptomTag, entry]) => ({
          symptomTag,
          entry,
          description: Object.hasOwn(catalog.symptomDescriptions, symptomTag)
            ? catalog.symptomDescriptions[symptomTag] ?? ""
            : "",
        })),
    [catalog.runbooks, catalog.symptomDescriptions],
  );

  const runbookCards = useMemo(() => {
    const statsById = new Map<string, RunbookSummary>();
    for (const item of runbookBreakdown) {
      statsById.set(item.runbookId, item);
    }
    const cards = catalogRunbooks.map(({ symptomTag, entry }) => ({
      runbookId: entry.runbookId,
      title: entry.title,
      symptomTag,
      stats: statsById.get(entry.runbookId) ?? null,
    }));
    const catalogIds = new Set(cards.map((c) => c.runbookId));
    for (const extra of runbookBreakdown) {
      if (!catalogIds.has(extra.runbookId)) {
        cards.push({
          runbookId: extra.runbookId,
          title: extra.runbookId,
          symptomTag: "custom_runbook",
          stats: extra,
        });
      }
    }
    return cards;
  }, [catalogRunbooks, runbookBreakdown]);

  const failingCount = mergedRows.filter((row) => !row.tool_passed).length;

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
      return compareScenarioIds(a.scenario_id, b.scenario_id);
    });
  }, [mergedRows, scenarioTab, searchQuery, sortBy]);

  const adversarialRows = useMemo(
    () => mergedRows.filter((row) => row.is_adversarial_injection),
    [mergedRows],
  );

  const injectionFailedRows = useMemo(
    () => mergedRows.filter((row) => !row.injection_blocked),
    [mergedRows],
  );

  const selectedDetailRow: MergedCaseRow | null = useMemo(
    () => mergedRows.find((row) => row.scenario_id === selectedScenarioId) ?? null,
    [mergedRows, selectedScenarioId],
  );

  const handleToggleTheme = useCallback(() => {
    setTheme((prevTheme) => {
      const nextTheme: ThemeMode = prevTheme === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", nextTheme);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
      } catch {
        // Ignore storage restrictions.
      }
      return nextTheme;
    });
  }, []);

  const handleSelectScenario = useCallback((scenarioId: string, toggleIfSame = false) => {
    setSelectedScenarioId((prev) => {
      const next = toggleIfSame && prev === scenarioId ? null : scenarioId;
      shouldScrollToDetailRef.current = next !== null;
      return next;
    });
  }, []);

  const handleJumpToScenario = useCallback((scenarioId: string) => {
    setActiveRunbookId(null);
    setScenarioTab("all");
    setSearchQuery("");
    setActiveView("benchmarks");
    shouldScrollToDetailRef.current = true;
    setSelectedScenarioId(scenarioId);
  }, []);

  const handleLoadPresetFromPalette = useCallback((presetId: string) => {
    presetNonceRef.current += 1;
    setPresetRequest({ presetId, nonce: presetNonceRef.current });
    setActiveView("triage");
  }, []);

  const handleOpenRunbookFromPalette = useCallback((runbookId: string) => {
    setActiveView("security");
    setActiveRunbookId(runbookId);
  }, []);

  function handleSelectRun(runId: string) {
    setSelectedRunId(runId);
    setSelectedScenarioId(null);
  }

  async function handleReportUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError(
        `File "${file.name}" is ${(file.size / (1024 * 1024)).toFixed(2)} MB, exceeding the 2.00 MB upload limit.`,
      );
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
        isUploaded: true,
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

  const report = activeDataset?.report ?? null;
  const gatePassed = report
    ? report.passed_ci_gate && report.gate_failures.length === 0
    : true;
  const latencyBreached =
    report && activeDataset ? report.p95_tool_latency_ms > activeDataset.latencyGateMs : false;
  const passDelta = report ? report.tool_pass_rate - report.baseline_pass_rate : 0;
  const passDeltaColor =
    passDelta > 0
      ? "var(--positive)"
      : passDelta < 0
        ? "var(--negative)"
        : "var(--muted)";

  return (
    <div className="min-h-dvh bg-[var(--ground)] text-[var(--text)]">
      {/* Top Operations Header */}
      <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1360px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-6">
            <button
              type="button"
              onClick={() => setActiveView("triage")}
              className="flex items-center gap-2.5 text-left"
            >
              <AgentGateMark />
              <div>
                <div className="text-[15px] font-semibold tracking-tight text-[var(--text)]">
                  AgentGate
                </div>
                <div className="text-[12px] text-[var(--muted)]">
                  Incident Triage &amp; Eval Console
                </div>
              </div>
            </button>

            <nav aria-label="Primary sections" className="hidden items-center gap-1 md:flex">
              {(
                [
                  ["triage", "Live Triage"],
                  ["benchmarks", "Eval Benchmarks"],
                  ["security", "Runbooks & Security"],
                ] as const
              ).map(([viewKey, label]) => {
                const active = activeView === viewKey;
                return (
                  <button
                    key={viewKey}
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => setActiveView(viewKey)}
                    className={`h-9 rounded-[6px] px-3 text-[13px] font-medium transition-colors ${
                      active
                        ? "bg-[var(--active)] text-[var(--text)]"
                        : "text-[var(--muted)] hover:bg-[var(--raised)] hover:text-[var(--text)]"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-keyshortcuts="Meta+k Control+k"
              aria-label="Open command palette"
              className="inline-flex h-8 items-center gap-2 rounded-[6px] border border-[var(--control)] bg-[var(--raised)] px-2.5 text-[12px] font-medium text-[var(--muted)] transition-colors hover:bg-[var(--active)] hover:text-[var(--text)]"
            >
              <span>Quick jump</span>
              <kbd className="rounded-[4px] border border-[var(--border-strong)] bg-[var(--surface)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text)]">
                ⌘K
              </kbd>
            </button>

            <button
              type="button"
              onClick={handleToggleTheme}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-[var(--control)] bg-[var(--raised)] px-3 text-[12px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--active)]"
            >
              <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
            </button>
          </div>

          {/* Mobile Primary Navigation */}
          <nav
            aria-label="Mobile sections"
            className="flex w-full items-center justify-between gap-1 overflow-x-auto border-t border-[var(--rule)] pt-2 md:hidden"
          >
            {(
              [
                ["triage", "Live Triage"],
                ["benchmarks", "Eval Benchmarks"],
                ["security", "Runbooks & Security"],
              ] as const
            ).map(([viewKey, label]) => {
              const active = activeView === viewKey;
              return (
                <button
                  key={viewKey}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => setActiveView(viewKey)}
                  className={`h-8 shrink-0 whitespace-nowrap rounded-[6px] px-2.5 text-[12px] font-medium transition-colors ${
                    active
                      ? "bg-[var(--active)] text-[var(--text)]"
                      : "text-[var(--muted)] hover:bg-[var(--raised)]"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1360px] px-4 py-6 sm:px-6">
        <div
          className={activeView === "triage" ? undefined : "hidden"}
          hidden={activeView !== "triage"}
        >
          <LiveTriageWorkbench
            presetRequest={presetRequest}
            onInspectRunbook={(runbookId) => setActiveRunbookId(runbookId)}
          />
        </div>

        {activeView === "benchmarks" && activeDataset && summary && report && (
          <div className="space-y-6">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="max-w-3xl">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text)]">
                    Evaluation benchmarks &amp; CI gate
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
                <p className="mt-1 text-[13px] text-[var(--muted)]">
                  {activeDataset.subtitle} · Engine:{" "}
                  <code className="text-[var(--text)]">{activeDataset.modelLabel}</code>
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {allDatasets.map((dataset) => {
                  const active = dataset.id === activeDataset.id;
                  return (
                    <button
                      key={dataset.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => handleSelectRun(dataset.id)}
                      className={`h-8 shrink-0 rounded-[6px] px-3 text-[13px] font-medium transition-colors ${
                        active
                          ? "bg-[var(--primary)] text-[var(--primary-ink)]"
                          : "border border-[var(--control)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--raised)]"
                      }`}
                    >
                      {dataset.label}
                    </button>
                  );
                })}

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  onChange={handleReportUpload}
                  className="hidden"
                  aria-label="Import EvalSuiteReport JSON file"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="h-8 shrink-0 rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--raised)]"
                >
                  Import JSON
                </button>
              </div>
            </div>

            {uploadError && (
              <div
                role="alert"
                className="flex items-center justify-between gap-3 rounded-[8px] border border-[var(--negative)] bg-[var(--pill-negative-bg)] px-4 py-2.5 text-[13px] text-[var(--pill-negative-ink)]"
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

            {!gatePassed && (
              <div
                role="alert"
                className="rounded-[8px] border border-[var(--negative)] bg-[var(--pill-negative-bg)] px-4 py-3 text-[13px] text-[var(--pill-negative-ink)]"
              >
                <div className="font-semibold">
                  CI quality gate failed for {activeDataset.label}
                </div>
                {report.gate_failures.length > 0 ? (
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
                    {report.gate_failures.map((failure, idx) => (
                      <li key={`${failure}-${idx}`} className="code-id text-[12px]">
                        {failure}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-[12px]">
                    Report specified passed_ci_gate = false without itemized failure messages.
                  </p>
                )}
              </div>
            )}

            {/* Dataset-Derived Summary & Optimization Strip */}
            <section
              aria-label="Dataset summary breakdown"
              className="grid grid-cols-1 gap-3 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4 md:grid-cols-3"
            >
              <div className="rounded-[8px] border border-[var(--border)] bg-[var(--raised)] p-3.5">
                <div className="text-[12px] font-medium text-[var(--muted)]">
                  Accuracy delta ({activeDataset.label})
                </div>
                <div className="num mt-1 text-[18px] font-semibold text-[var(--text)]">
                  {formatPercent(report.baseline_pass_rate)} →{" "}
                  {formatPercent(report.tool_pass_rate)} ({summary.toolPassedCount}/
                  {summary.totalCases})
                </div>
                <div className="num mt-1 text-[12px]" style={{ color: passDeltaColor }}>
                  {formatSignedPp(passDelta)} · {summary.improvedCount} improved by MCP
                  {summary.regressedCount > 0 ? ` · ${summary.regressedCount} regressed` : ""}
                </div>
              </div>

              <div className="rounded-[8px] border border-[var(--border)] bg-[var(--raised)] p-3.5">
                <div className="text-[12px] font-medium text-[var(--muted)]">
                  {activeDataset.id === "gemini-live"
                    ? "Live pacing vs. net execution p95"
                    : "Latency profile (p95 vs. median)"}
                </div>
                <div className="num mt-1 text-[18px] font-semibold text-[var(--text)]">
                  {activeDataset.id === "gemini-live" && summary.p95ToolNetMs !== null
                    ? `${formatMs(summary.p95ToolNetMs)} net · ${formatMs(report.p95_tool_latency_ms)} paced`
                    : `MCP ${formatMs(report.p95_tool_latency_ms)} · Base ${formatMs(summary.p95BaselineMs)}`}
                </div>
                <div className="num mt-1 text-[12px] text-[var(--muted)]">
                  {activeDataset.id === "gemini-live" && summary.p95ToolNetMs !== null
                    ? `Shared RequestPacer + batched MCP turns (${formatMs(Math.max(0, report.p95_tool_latency_ms - summary.p95ToolNetMs))} pacing delta · ${summary.p95BaselineNetMs !== null ? `Base net p95 ${formatMs(summary.p95BaselineNetMs)}` : `Base p95 ${formatMs(summary.p95BaselineMs)}`})`
                    : summary.p95ToolNetMs !== null
                      ? `Net non-pacing p95: MCP ${formatMs(summary.p95ToolNetMs)}${summary.p95BaselineNetMs !== null ? ` · Base ${formatMs(summary.p95BaselineNetMs)}` : ""}`
                      : `p50 median: MCP ${formatMs(summary.p50ToolMs)} · Base ${formatMs(summary.p50BaselineMs)}`}
                </div>
              </div>

              <div className="rounded-[8px] border border-[var(--border)] bg-[var(--raised)] p-3.5">
                <div className="text-[12px] font-medium text-[var(--muted)]">
                  Token &amp; gate posture
                </div>
                <div className="num mt-1 text-[18px] font-semibold text-[var(--text)]">
                  {summary.totalTokens > 0
                    ? `${formatInt(summary.totalTokens)} MCP tok (${formatInt(summary.baselineTotalTokens)} base)`
                    : `0 tokens · ${summary.totalCases} cases`}
                </div>
                <div className="num mt-1 text-[12px] text-[var(--muted)]">
                  Floors: pass ≥ {formatPercent(activeDataset.minToolPassRate)} · delta ≥{" "}
                  {formatSignedPp(activeDataset.minDelta)} · p95 ≤{" "}
                  {formatMs(activeDataset.latencyGateMs)}
                </div>
              </div>
            </section>

            {/* Primary KPIs */}
            <section
              aria-label="Key evaluation metrics"
              className="grid grid-cols-2 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] lg:grid-cols-5"
            >
              <div className="col-span-2 border-b border-[var(--rule)] p-4 lg:col-span-1 lg:border-b-0 lg:border-r">
                <div className="text-[13px] font-medium text-[var(--muted)]">MCP pass rate</div>
                <div className="num mt-1 text-[30px] font-semibold leading-tight text-[var(--text)]">
                  {formatPercent(report.tool_pass_rate)}
                </div>
                <div
                  className="num mt-1 text-[13px] font-medium"
                  style={{ color: passDeltaColor }}
                >
                  {formatSignedPp(passDelta)} vs baseline
                </div>
              </div>

              <div className="border-b border-r border-[var(--rule)] p-4 lg:border-b-0">
                <div className="text-[13px] font-medium text-[var(--muted)]">
                  Baseline pass rate
                </div>
                <div className="num mt-1 text-[24px] font-semibold leading-tight text-[var(--text)]">
                  {formatPercent(report.baseline_pass_rate)}
                </div>
                <div className="num mt-1 text-[13px] text-[var(--muted)]">
                  {summary.baselinePassedCount} / {summary.totalCases} no-tool
                </div>
              </div>

              <div className="border-b border-[var(--rule)] p-4 lg:border-b-0 lg:border-r">
                <div className="text-[13px] font-medium text-[var(--muted)]">Schema validity</div>
                <div className="num mt-1 text-[24px] font-semibold leading-tight text-[var(--text)]">
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
                <div className="num mt-1 text-[24px] font-semibold leading-tight text-[var(--text)]">
                  {formatPercent(report.injection_block_rate)}
                </div>
                <div className="num mt-1 text-[13px] text-[var(--muted)]">
                  {summary.adversarialTotal > 0
                    ? `${summary.adversarialBlocked} / ${summary.adversarialTotal} blocked`
                    : `${summary.totalCases - injectionFailedRows.length} / ${summary.totalCases} clean`}
                </div>
              </div>

              <div className="p-4">
                <div className="text-[13px] font-medium text-[var(--muted)]">Tool p95 latency</div>
                <div
                  className="num mt-1 text-[24px] font-semibold leading-tight"
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
                  onSelectScenario={(id) => handleSelectScenario(id, true)}
                />
              </div>

              <section className="flex flex-col justify-between rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-5 xl:col-span-4">
                <div>
                  <h2 className="text-[16px] font-semibold text-[var(--text)]">CI gate checks</h2>
                  <p className="mt-0.5 text-[13px] text-[var(--muted)]">
                    Automated pass/fail quality floors enforced on pull requests.
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
                          <div className="num text-[12px] text-[var(--muted)]">
                            Target {check.target}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="num text-[13px] font-medium text-[var(--text)]">
                            {check.measured}
                          </span>
                          <span
                            className="inline-flex items-center rounded-[4px] px-2 py-0.5 text-[11px] font-medium"
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

                <div className="mt-5 flex items-center justify-between gap-3 border-t border-[var(--rule)] pt-4 text-[13px] text-[var(--muted)]">
                  <span className="num">
                    {summary.totalTokens > 0
                      ? `${formatInt(summary.totalTokens)} total tool tokens`
                      : "Deterministic CI run (0 tokens)"}
                  </span>
                  <span className="num">{summary.improvedCount} cases improved by MCP</span>
                </div>
              </section>
            </div>

            {selectedDetailRow && (
              <div id="scenario-detail" ref={detailPanelRef} className="scroll-mt-20">
                <ScenarioDetailPanel
                  row={selectedDetailRow}
                  onClose={() => setSelectedScenarioId(null)}
                />
              </div>
            )}

            {/* Scenario Explorer */}
            <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 className="text-[16px] font-semibold text-[var(--text)]">
                    Benchmark scenario explorer
                  </h2>
                  <p className="mt-0.5 text-[13px] text-[var(--muted)]">
                    Click any row to inspect the alert payload, predicted vs. expected outputs, and
                    token spend.
                  </p>
                </div>
                <span className="num text-[13px] text-[var(--muted)]">
                  {filteredScenarios.length} of {summary.totalCases} scenarios
                </span>
              </div>

              <div className="mt-4 border-b border-[var(--border)]">
                <div
                  className="-mb-px flex flex-wrap gap-6"
                  role="tablist"
                  aria-label="Scenario filters"
                >
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
                        className={`border-b-2 pb-2.5 text-[13px] font-medium transition-colors ${
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

              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
                    className="h-8 w-full max-w-[320px] rounded-[6px] border border-[var(--control)] bg-[var(--raised)] px-3 text-[13px] text-[var(--text)] placeholder:text-[var(--faint)]"
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
                    className="h-8 rounded-[6px] border border-[var(--control)] bg-[var(--raised)] px-2.5 text-[13px] text-[var(--text)]"
                  >
                    <option value="id">Scenario ID</option>
                    <option value="latency">Slowest tool latency</option>
                    <option value="tokens">Highest token spend</option>
                  </select>
                </div>
              </div>

              {filteredScenarios.length === 0 ? (
                <div className="mt-4 rounded-[8px] border border-dashed border-[var(--control)] bg-[var(--raised)] px-4 py-8 text-center">
                  <p className="text-[14px] text-[var(--text)]">
                    No scenarios match the current filter.
                  </p>
                </div>
              ) : (
                <ScenarioTable
                  rows={filteredScenarios}
                  selectedId={selectedScenarioId}
                  onSelect={(id) => handleSelectScenario(id, true)}
                />
              )}
            </section>
          </div>
        )}

        {activeView === "security" && activeDataset && summary && report && (
          <div className="space-y-6">
            <div>
              <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text)]">
                Runbook coverage &amp; injection audit
              </h1>
              <p className="mt-1 text-[14px] text-[var(--muted)]">
                Verification across all {catalogRunbooks.length} read-only MCP runbooks and{" "}
                {summary.adversarialTotal} adversarial prompt-injection probe
                {summary.adversarialTotal === 1 ? "" : "s"} for {activeDataset.label}.
              </p>
            </div>

            <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-12">
              <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-5 xl:col-span-6">
                <h2 className="text-[16px] font-semibold text-[var(--text)]">
                  Verified MCP runbooks
                </h2>
                <p className="mt-0.5 text-[13px] text-[var(--muted)]">
                  Click any runbook card to inspect remediation checks, symptom disambiguation, and
                  SLA latency budgets.
                </p>

                {runbookBreakdown.length === 0 && (
                  <div className="mt-4 rounded-[8px] border border-dashed border-[var(--control)] bg-[var(--raised)] px-4 py-3 text-[13px] text-[var(--muted)]">
                    None of the scenario IDs in {activeDataset.label} matched local expected
                    runbooks in <code>scenarios.json</code>. Reference catalog runbooks remain
                    inspectable below.
                  </div>
                )}

                <div className="mt-4 space-y-2.5">
                  {runbookCards.map((card) => {
                    const stats = card.stats;
                    const ratio = stats && stats.total > 0 ? stats.toolPassed / stats.total : 0;
                    const allPass = stats ? stats.toolPassed === stats.total : true;
                    return (
                      <button
                        key={card.runbookId}
                        type="button"
                        onClick={() => setActiveRunbookId(card.runbookId)}
                        className="block w-full rounded-[8px] border border-[var(--border)] bg-[var(--raised)] p-3.5 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--active)]"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <code className="text-[13px] font-medium text-[var(--accent)]">
                                {card.runbookId}
                              </code>
                              <span className="truncate text-[13px] font-medium text-[var(--text)]">
                                {card.title}
                              </span>
                            </div>
                            <div className="mt-0.5 text-[12px] text-[var(--muted)]">
                              Symptom: <code>{card.symptomTag}</code>
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-3 text-[12px]">
                            {stats ? (
                              <>
                                <span className="num text-[var(--muted)]">
                                  avg {formatMs(stats.avgToolMs)}
                                </span>
                                <span
                                  className="num font-medium"
                                  style={{
                                    color: allPass ? "var(--positive)" : "var(--negative)",
                                  }}
                                >
                                  {stats.toolPassed} / {stats.total}
                                </span>
                              </>
                            ) : (
                              <span className="text-[var(--muted)]">Inspect checks →</span>
                            )}
                          </div>
                        </div>

                        {stats && (
                          <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-[2px] bg-[var(--rule)]">
                            <div
                              className="h-full"
                              style={{
                                width: `${ratio * 100}%`,
                                backgroundColor: allPass ? "var(--chart-1)" : "var(--negative)",
                              }}
                            />
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-5 xl:col-span-6">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h2 className="text-[16px] font-semibold text-[var(--text)]">
                      Prompt-injection resistance audit
                    </h2>
                    <p className="mt-0.5 text-[13px] text-[var(--muted)]">
                      Adversarial overrides inside alert payloads and untrusted MCP log telemetry.
                    </p>
                  </div>
                  {summary.adversarialTotal > 0 ? (
                    <span
                      className="num shrink-0 rounded-[4px] px-2 py-0.5 text-[12px] font-medium"
                      style={{
                        backgroundColor:
                          summary.adversarialBlocked === summary.adversarialTotal &&
                          report.injection_block_rate >= 1.0
                            ? "var(--pill-positive-bg)"
                            : "var(--pill-negative-bg)",
                        color:
                          summary.adversarialBlocked === summary.adversarialTotal &&
                          report.injection_block_rate >= 1.0
                            ? "var(--pill-positive-ink)"
                            : "var(--pill-negative-ink)",
                      }}
                    >
                      {summary.adversarialBlocked} / {summary.adversarialTotal} blocked
                    </span>
                  ) : (
                    <span
                      className="num shrink-0 rounded-[4px] px-2 py-0.5 text-[12px] font-medium"
                      style={{
                        backgroundColor:
                          report.injection_block_rate >= 1.0
                            ? "var(--pill-positive-bg)"
                            : "var(--pill-negative-bg)",
                        color:
                          report.injection_block_rate >= 1.0
                            ? "var(--pill-positive-ink)"
                            : "var(--pill-negative-ink)",
                      }}
                    >
                      Rate: {formatPercent(report.injection_block_rate)}
                    </span>
                  )}
                </div>

                {adversarialRows.length === 0 ? (
                  <div className="mt-4 space-y-3">
                    <div className="rounded-[8px] border border-dashed border-[var(--control)] bg-[var(--raised)] p-4 text-[13px] text-[var(--muted)]">
                      No rows in {activeDataset.label} matched the default adversarial scenario IDs
                      in <code>scenarios.json</code>. Overall reported{" "}
                      <code>injection_block_rate</code> is{" "}
                      <strong
                        className="num"
                        style={{
                          color:
                            report.injection_block_rate >= 1.0
                              ? "var(--positive)"
                              : "var(--negative)",
                        }}
                      >
                        {formatPercent(report.injection_block_rate)}
                      </strong>
                      .
                    </div>

                    {injectionFailedRows.length > 0 && (
                      <div className="divide-y divide-[var(--rule)] rounded-[8px] border border-[var(--negative)] bg-[var(--surface)] px-4">
                        {injectionFailedRows.map((row) => (
                          <div
                            key={row.scenario_id}
                            className="flex items-center justify-between gap-2 py-2.5"
                          >
                            <code className="text-[12px] font-medium text-[var(--accent)]">
                              {row.scenario_id}
                            </code>
                            <span
                              className="rounded-[4px] px-2 py-0.5 text-[11px] font-medium"
                              style={{
                                backgroundColor: "var(--pill-negative-bg)",
                                color: "var(--pill-negative-ink)",
                              }}
                            >
                              Bypassed
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mt-4 divide-y divide-[var(--rule)]">
                    {adversarialRows.map((row) => (
                      <div key={row.scenario_id} className="py-3 first:pt-0 last:pb-0">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <code className="shrink-0 text-[12px] font-medium text-[var(--accent)]">
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
                )}
              </section>
            </div>
          </div>
        )}
      </main>

      <RunbookDrawer
        runbookId={activeRunbookId}
        catalog={catalog}
        rows={mergedRows}
        activeDatasetLabel={activeDataset?.label ?? "Active Suite"}
        onClose={() => setActiveRunbookId(null)}
        onSelectScenario={handleJumpToScenario}
      />

      <CommandPalette
        open={paletteOpen}
        theme={theme}
        activeDatasetLabel={activeDataset?.label ?? "Active Suite"}
        catalog={catalog}
        scenarios={mergedRows}
        onClose={() => setPaletteOpen(false)}
        onSwitchView={(view) => setActiveView(view)}
        onToggleTheme={handleToggleTheme}
        onLoadPreset={handleLoadPresetFromPalette}
        onOpenRunbook={handleOpenRunbookFromPalette}
        onSelectScenario={handleJumpToScenario}
      />
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
              aria-expanded={isSelected}
              onClick={() => onSelect(row.scenario_id)}
              className={`block w-full px-2 py-3 text-left transition-colors ${
                isSelected ? "bg-[var(--active)]" : "hover:bg-[var(--raised)]"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <code className="shrink-0 text-[12px] font-medium text-[var(--accent)]">
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
                    <button
                      type="button"
                      aria-expanded={isSelected}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(row.scenario_id);
                      }}
                      className="flex max-w-full items-center gap-2.5 text-left hover:underline"
                    >
                      <code className="shrink-0 text-[13px] font-medium text-[var(--accent)]">
                        {row.scenario_id}
                      </code>
                      <span className="truncate font-medium text-[var(--text)]">
                        {row.title}
                      </span>
                      {row.is_adversarial_injection && (
                        <span
                          className="shrink-0 rounded-[4px] px-1.5 py-0.5 text-[11px] font-medium"
                          style={{
                            backgroundColor: "var(--pill-warning-bg)",
                            color: "var(--pill-warning-ink)",
                          }}
                        >
                          Injection
                        </span>
                      )}
                    </button>
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
