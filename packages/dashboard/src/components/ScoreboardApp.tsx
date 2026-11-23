"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { AgentGateMark } from "@/components/AgentGateMark";
import { CommandPalette } from "@/components/CommandPalette";
import {
  LiveTriageWorkbench,
  type LiveTriageCustomRequest,
  type LiveTriagePresetRequest,
} from "@/components/LiveTriageWorkbench";
import { BenchmarksView, type ScenarioTab, type SortOption } from "@/components/benchmarks/BenchmarksView";
import { RunbooksView } from "@/components/runbooks/RunbooksView";
import { RunbookDrawer } from "@/components/RunbookDrawer";
import {
  buildGateChecks,
  buildRunbookBreakdown,
  compareScenarioIds,
  computeSummaryMetrics,
  formatPercent,
  mergeCases,
  parseUploadedReport,
  type EvalScenario,
  type McpCatalog,
  type MergedCaseRow,
  type RunDataset,
  type RunbookSummary,
} from "@/lib/evalData";
import { TRIAGE_PRESETS } from "@/lib/triageCatalog";

interface ScoreboardAppProps {
  readonly datasets: readonly RunDataset[];
  readonly scenarios: readonly EvalScenario[];
  readonly catalog: McpCatalog;
}

type NavView = "triage" | "benchmarks" | "security";
type ThemeMode = "dark" | "light";

const THEME_STORAGE_KEY = "agentgate-theme";
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

const SERVICE_BY_RUNBOOK: Readonly<Record<string, string>> = {
  "rb-latency-pool": "checkout-api",
  "rb-webhook-retry": "payments-worker",
  "rb-hmac-rotation": "webhook-ingress",
  "rb-net-vlan": "edge-switch-01",
  "rb-tls-renewal": "auth-gateway",
  "rb-cache-eviction": "session-cache",
  "rb-dns-resolver": "core-dns",
  "rb-lambda-limits": "triage-lambda",
};

function inferServiceFromPayload(
  payloadText: string,
  expectedRunbook: string | null,
  knownServices: readonly string[],
): string {
  const lowered = payloadText.toLowerCase();
  for (const svc of knownServices) {
    if (lowered.includes(svc)) return svc;
  }
  if (expectedRunbook && Object.hasOwn(SERVICE_BY_RUNBOOK, expectedRunbook)) {
    return SERVICE_BY_RUNBOOK[expectedRunbook] ?? "checkout-api";
  }
  return "edge-node-2";
}

function extractP95FromPayload(payloadText: string): number | null {
  const match = payloadText.match(/\bp95(?:\s+latency)?[:\s=]+(\d+(?:\.\d+)?)\s*ms\b/i);
  if (!match?.[1]) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function ScoreboardApp({ datasets, scenarios, catalog }: ScoreboardAppProps) {
  const [uploadedDatasets, setUploadedDatasets] = useState<readonly RunDataset[]>([]);
  const allDatasets = useMemo(() => [...datasets, ...uploadedDatasets], [datasets, uploadedDatasets]);

  const [activeView, setActiveView] = useState<NavView>("triage");
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [mobileNavOpen, setMobileNavOpen] = useState<boolean>(false);
  const [selectedRunId, setSelectedRunId] = useState<string>(datasets[0]?.id ?? "gemini-live");
  const [scenarioTab, setScenarioTab] = useState<ScenarioTab>("all");
  const [sortBy, setSortBy] = useState<SortOption>("id");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [activeRunbookId, setActiveRunbookId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);
  const [presetRequest, setPresetRequest] = useState<LiveTriagePresetRequest | null>(null);
  const [customRequest, setCustomRequest] = useState<LiveTriageCustomRequest | null>(null);
  const [liveStatus, setLiveStatus] = useState<{
    liveAiConfigured: boolean;
    claimedKeyCount: number;
  }>({ liveAiConfigured: false, claimedKeyCount: 0 });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const detailPanelRef = useRef<HTMLDivElement>(null);
  const shouldScrollToDetailRef = useRef<boolean>(false);
  const requestNonceRef = useRef<number>(0);

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
      // Ignore storage restrictions
    }
  }, []);

  useEffect(() => {
    function handleGlobalKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((prev) => !prev);
      } else if (event.key === "Escape" && mobileNavOpen) {
        setMobileNavOpen(false);
      }
    }
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [mobileNavOpen]);

  useEffect(() => {
    if (activeView !== "benchmarks" || !selectedScenarioId || !shouldScrollToDetailRef.current) return;
    shouldScrollToDetailRef.current = false;
    const raf = window.requestAnimationFrame(() => {
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      detailPanelRef.current?.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "nearest",
      });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [activeView, selectedScenarioId]);

  const activeDataset = allDatasets.find((item) => item.id === selectedRunId) ?? allDatasets[0];
  const mergedRows = useMemo(
    () => (activeDataset ? mergeCases(activeDataset.report, scenarios) : []),
    [activeDataset, scenarios],
  );
  const summary = useMemo(
    () => (activeDataset ? computeSummaryMetrics(activeDataset.report, mergedRows) : null),
    [activeDataset, mergedRows],
  );
  const gateChecks = useMemo(
    () => (activeDataset ? buildGateChecks(activeDataset.report, activeDataset) : []),
    [activeDataset],
  );
  const runbookBreakdown = useMemo(() => buildRunbookBreakdown(mergedRows), [mergedRows]);
  const catalogRunbooks = useMemo(
    () =>
      Object.entries(catalog.runbooks)
        .filter(([symptomTag]) => Object.hasOwn(catalog.runbooks, symptomTag))
        .map(([symptomTag, entry]) => ({ symptomTag, entry })),
    [catalog.runbooks],
  );

  const runbookCards = useMemo(() => {
    const statsById = new Map<string, RunbookSummary>();
    for (const item of runbookBreakdown) statsById.set(item.runbookId, item);
    return catalogRunbooks.map(({ symptomTag, entry }) => ({
      runbookId: entry.runbookId,
      title: entry.title,
      symptomTag,
      stats: statsById.get(entry.runbookId) ?? null,
    }));
  }, [catalogRunbooks, runbookBreakdown]);

  const serviceBudgets = useMemo(
    () =>
      Object.entries(catalog.serviceBudgetsMs).filter(([svc]) =>
        Object.hasOwn(catalog.serviceBudgetsMs, svc),
      ),
    [catalog.serviceBudgetsMs],
  );

  const failingCount = mergedRows.filter((row) => !row.tool_passed).length;
  const filteredScenarios = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return mergedRows
      .filter((row) => {
        if (scenarioTab === "failed" && row.tool_passed) return false;
        if (scenarioTab === "improved" && !(!row.baseline_passed && row.tool_passed)) return false;
        if (scenarioTab === "adversarial" && !row.is_adversarial_injection) return false;
        if (!q) return true;
        return (
          row.scenario_id.toLowerCase().includes(q) ||
          row.title.toLowerCase().includes(q) ||
          (row.expected_runbook ?? "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        if (sortBy === "latency") return b.tool_latency_ms - a.tool_latency_ms;
        if (sortBy === "tokens") return b.total_tokens - a.total_tokens;
        return compareScenarioIds(a.scenario_id, b.scenario_id);
      });
  }, [mergedRows, scenarioTab, searchQuery, sortBy]);

  const adversarialRows = useMemo(
    () => mergedRows.filter((row) => row.is_adversarial_injection),
    [mergedRows],
  );
  const selectedDetailRow = useMemo(
    () => mergedRows.find((row) => row.scenario_id === selectedScenarioId) ?? null,
    [mergedRows, selectedScenarioId],
  );

  const handleToggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: ThemeMode = prev === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {}
      return next;
    });
  }, []);

  const handleStatusSync = useCallback(
    (status: { liveAiConfigured: boolean; claimedKeyCount: number }) => setLiveStatus(status),
    [],
  );

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

  const handleLoadPreset = useCallback((presetId: string) => {
    requestNonceRef.current += 1;
    setPresetRequest({ presetId, nonce: requestNonceRef.current });
    setActiveView("triage");
    setMobileNavOpen(false);
  }, []);

  const handleLoadScenarioInWorkbench = useCallback(
    (row: MergedCaseRow) => {
      requestNonceRef.current += 1;
      setCustomRequest({
        nonce: requestNonceRef.current,
        service: inferServiceFromPayload(row.payload_text, row.expected_runbook, catalog.knownServices),
        p95Ms: extractP95FromPayload(row.payload_text),
        payloadText: row.payload_text,
      });
      setActiveView("triage");
      setMobileNavOpen(false);
    },
    [catalog.knownServices],
  );

  const handleLoadRunbookInWorkbench = useCallback(
    (service: string, symptomTag: string) => {
      requestNonceRef.current += 1;
      const budget = Object.hasOwn(catalog.serviceBudgetsMs, service)
        ? catalog.serviceBudgetsMs[service] ?? catalog.defaultBudgetMs
        : catalog.defaultBudgetMs;
      const breachedP95 = Math.round(budget * 3.2);
      const cleanLogs = Object.hasOwn(catalog.defaultLogs, service) ? catalog.defaultLogs[service] ?? [] : [];
      const firstLog = cleanLogs.find((line) => !/SYSTEM OVERRIDE/i.test(line)) ?? symptomTag;
      setActiveRunbookId(null);
      setCustomRequest({
        nonce: requestNonceRef.current,
        service,
        p95Ms: breachedP95,
        payloadText: `Alert on ${service}: p95 latency ${breachedP95}ms. Telemetry signal (${symptomTag}): ${firstLog}`,
      });
      setActiveView("triage");
      setMobileNavOpen(false);
    },
    [catalog],
  );

  const handleReportUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError(`File "${file.name}" exceeds 2.00 MB limit.`);
      return;
    }
    try {
      const report = parseUploadedReport(await file.text());
      const id = `uploaded-${Date.now()}`;
      setUploadedDatasets((prev) => [
        ...prev,
        {
          id,
          label: file.name.replace(/\.json$/i, ""),
          subtitle: "Uploaded EvalSuiteReport JSON artifact",
          modelLabel: "Custom JSON artifact",
          latencyGateMs: 20000,
          minToolPassRate: 0.85,
          minDelta: 0.0,
          isUploaded: true,
          report,
        },
      ]);
      setSelectedRunId(id);
      setSelectedScenarioId(null);
      setUploadError(null);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Unable to read uploaded JSON report.");
    }
  };

  const report = activeDataset?.report ?? null;
  const gatePassed = report ? report.passed_ci_gate && report.gate_failures.length === 0 : true;
  const viewTitleBreadcrumb =
    activeView === "triage"
      ? "Incident Triage"
      : activeView === "benchmarks"
        ? "Eval Benchmarks"
        : "Runbook Catalog";

  const sidebarItems: ReadonlyArray<{
    readonly key: NavView;
    readonly label: string;
    readonly count: number;
  }> = [
    { key: "triage", label: "Incident Triage", count: TRIAGE_PRESETS.length },
    { key: "benchmarks", label: "Eval Benchmarks", count: report ? report.results.length : scenarios.length },
    { key: "security", label: "Runbook Catalog", count: catalogRunbooks.length },
  ];

  function renderSidebarContent(isDrawer: boolean) {
    return (
      <div className="flex h-full flex-col justify-between gap-6 p-3.5">
        <div className="space-y-6">
          <div className="flex items-center justify-between gap-2 px-1">
            <button
              type="button"
              onClick={() => {
                setActiveView("triage");
                setMobileNavOpen(false);
              }}
              className="flex items-center gap-2.5 text-left"
            >
              <AgentGateMark />
              <div>
                <div className="text-[14px] font-semibold tracking-tight text-[var(--text)]">AgentGate</div>
                <div className="text-[13px] text-[var(--muted)]">prod-eu-west · v2 HMAC</div>
              </div>
            </button>
            {isDrawer && (
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                className="h-8 rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-2.5 text-[13px] font-medium text-[var(--text)]"
              >
                Close
              </button>
            )}
          </div>

          <nav aria-label={isDrawer ? "Mobile sidebar navigation" : "Sidebar navigation"}>
            <div className="mb-1.5 px-2 text-[13px] font-medium text-[var(--muted)]">Workspace</div>
            <ul className="space-y-1">
              {sidebarItems.map((item) => {
                const active = activeView === item.key;
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      aria-current={active ? "page" : undefined}
                      onClick={() => {
                        setActiveView(item.key);
                        setMobileNavOpen(false);
                      }}
                      className={`flex h-9 w-full items-center justify-between rounded-[6px] border-l-2 px-2.5 text-[13px] ${
                        active
                          ? "border-[var(--accent)] bg-[var(--active)] font-semibold text-[var(--text)]"
                          : "border-transparent text-[var(--muted)] hover:bg-[var(--raised)] hover:text-[var(--text)]"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        {item.key === "triage" && (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                          </svg>
                        )}
                        {item.key === "benchmarks" && (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <rect x="3" y="3" width="7" height="7" rx="1" />
                            <rect x="14" y="3" width="7" height="7" rx="1" />
                            <rect x="14" y="14" width="7" height="7" rx="1" />
                            <rect x="3" y="14" width="7" height="7" rx="1" />
                          </svg>
                        )}
                        {item.key === "security" && (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                          </svg>
                        )}
                        <span>{item.label}</span>
                      </span>
                      <span className="num text-[13px] text-[var(--muted)]">{item.count}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div>
            <div className="mb-1.5 flex items-center justify-between px-2 text-[13px] font-medium text-[var(--muted)]">
              <span>Monitors ({TRIAGE_PRESETS.length})</span>
              <span className="text-[13px]">SLO Status</span>
            </div>
            <ul className="space-y-1">
              {TRIAGE_PRESETS.map((preset) => {
                const dotColor =
                  preset.id === "preset-db-pool" || preset.id === "preset-tls-expiry"
                    ? "var(--negative)"
                    : preset.id === "preset-prompt-injection"
                      ? "var(--warning)"
                      : "var(--positive)";
                return (
                  <li key={preset.id}>
                    <button
                      type="button"
                      onClick={() => handleLoadPreset(preset.id)}
                      className="flex w-full items-center justify-between gap-1.5 rounded-[6px] px-1.5 py-1.5 text-left text-[13px] text-[var(--muted)] hover:bg-[var(--raised)] hover:text-[var(--text)]"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dotColor }} />
                        <span className="truncate font-medium text-[var(--text)]">{preset.service}</span>
                      </span>
                      <span className="num shrink-0 text-[13px] text-[var(--muted)]">
                        {preset.p95Ms !== null ? `${preset.p95Ms}ms` : "bait"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        <div className="space-y-2.5 rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-3 text-[13px]">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-[var(--text)]">Event Gateway</span>
            <span className="rounded-[3px] bg-[var(--pill-positive-bg)] px-1.5 py-0.5 text-[13px] font-medium text-[var(--pill-positive-ink)]">
              v2 HMAC
            </span>
          </div>
          <div className="code-id flex items-center justify-between rounded-[6px] border border-[var(--border)] bg-[var(--ground)] px-2.5 py-2 text-[13px] text-[var(--muted)]">
            <span className="text-[var(--text)]">6 Sources</span>
            <span>&rarr;</span>
            <span className="font-semibold text-[var(--accent)]">Gate</span>
            <span>&rarr;</span>
            <span className="text-[var(--positive)]">3 MCP</span>
          </div>
          <div className="space-y-1 pt-0.5 text-[13px]">
            <div className="flex items-center justify-between text-[var(--muted)]">
              <span>Ledger keys</span>
              <span className="num text-[var(--text)]">{liveStatus.claimedKeyCount} claimed</span>
            </div>
            {report && (
              <div className="flex items-center justify-between text-[var(--muted)]">
                <span>CI quality gate</span>
                <span className="font-medium" style={{ color: gatePassed ? "var(--positive)" : "var(--negative)" }}>
                  {gatePassed ? "Pass" : "Fail"} ({formatPercent(report.tool_pass_rate)})
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh bg-[var(--ground)] text-[var(--text)]">
      <aside className="hidden w-[224px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--ground)] lg:flex">
        {renderSidebarContent(false)}
      </aside>

      {mobileNavOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Mobile workspace navigation"
          className="fixed inset-0 z-50 flex bg-black/50 lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        >
          <div
            className="drawer-enter h-full w-[264px] border-r border-[var(--border)] bg-[var(--ground)]"
            onClick={(e) => e.stopPropagation()}
          >
            {renderSidebarContent(true)}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 px-4 lg:px-6">
          <div className="flex shrink-0 items-center gap-2.5">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation menu"
              className="inline-flex h-8 items-center rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-2.5 text-[13px] font-medium text-[var(--text)] lg:hidden"
            >
              Menu
            </button>
            <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[13px]">
              <span className="hidden text-[var(--muted)] sm:inline">prod-eu-west</span>
              <span className="hidden text-[var(--muted)] sm:inline">/</span>
              <span className="font-medium text-[var(--text)]">{viewTitleBreadcrumb}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-keyshortcuts="Meta+k Control+k"
            aria-label="Open command palette"
            className="hidden h-8 min-w-0 flex-1 max-w-[380px] items-center justify-between rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--muted)] hover:border-[var(--control)] hover:text-[var(--text)] md:inline-flex"
          >
            <span className="truncate">Jump to incident, runbook, or eval...</span>
            <kbd className="ml-2 shrink-0 rounded-[4px] border border-[var(--border)] bg-[var(--raised)] px-1.5 py-0.5 text-[13px] text-[var(--text)]">
              ⌘K
            </kbd>
          </button>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="inline-flex h-8 items-center rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[13px] font-medium text-[var(--text)] md:hidden"
            >
              ⌘K
            </button>
            <span
              className="hidden h-8 items-center rounded-[4px] px-2.5 text-[13px] font-medium sm:inline-flex"
              style={{
                backgroundColor: liveStatus.liveAiConfigured
                  ? "var(--pill-positive-bg)"
                  : "var(--pill-neutral-bg)",
                color: liveStatus.liveAiConfigured
                  ? "var(--pill-positive-ink)"
                  : "var(--pill-neutral-ink)",
              }}
            >
              {liveStatus.liveAiConfigured ? "Gemini Live ready" : "MCP Instant mode"}
            </span>
            <button
              type="button"
              onClick={handleToggleTheme}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              className="inline-flex h-8 items-center rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text)] hover:bg-[var(--raised)]"
            >
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </button>
          </div>
        </header>

        <main
          className={`min-w-0 flex-1 p-4 sm:p-5 ${
            theme === "light"
              ? "border-t border-[var(--border)] bg-[var(--surface)] lg:mb-2 lg:mr-2 lg:rounded-[16px] lg:border"
              : "border-t border-[var(--border)] bg-[var(--ground)]"
          }`}
        >
          <div className="mx-auto max-w-[1400px]">
            <div className={activeView === "triage" ? "block" : "hidden"}>
              <LiveTriageWorkbench
                presetRequest={presetRequest}
                customRequest={customRequest}
                onInspectRunbook={(runbookId) => setActiveRunbookId(runbookId)}
                onStatusSync={handleStatusSync}
              />
            </div>

            {activeView === "benchmarks" && (
              <BenchmarksView
                allDatasets={allDatasets}
                activeDataset={activeDataset}
                summary={summary}
                mergedRows={mergedRows}
                filteredScenarios={filteredScenarios}
                failingCount={failingCount}
                gateChecks={gateChecks}
                selectedScenarioId={selectedScenarioId}
                selectedDetailRow={selectedDetailRow}
                scenarioTab={scenarioTab}
                setScenarioTab={setScenarioTab}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                sortBy={sortBy}
                setSortBy={setSortBy}
                uploadError={uploadError}
                fileInputRef={fileInputRef}
                detailPanelRef={detailPanelRef}
                onSelectRun={(runId) => {
                  setSelectedRunId(runId);
                  setSelectedScenarioId(null);
                }}
                onReportUpload={handleReportUpload}
                onSelectScenario={handleSelectScenario}
                onClearScenario={() => setSelectedScenarioId(null)}
                onLoadInWorkbench={handleLoadScenarioInWorkbench}
              />
            )}

            {activeView === "security" && (
              <RunbooksView
                runbookCards={runbookCards}
                adversarialRows={adversarialRows}
                serviceBudgets={serviceBudgets}
                catalog={catalog}
                report={report}
                summary={summary}
                serviceByRunbook={SERVICE_BY_RUNBOOK}
                onInspectRunbook={(runbookId) => setActiveRunbookId(runbookId)}
                onTestRunbookInWorkbench={handleLoadRunbookInWorkbench}
                onLoadScenarioInWorkbench={handleLoadScenarioInWorkbench}
              />
            )}
          </div>
        </main>
      </div>

      <RunbookDrawer
        runbookId={activeRunbookId}
        catalog={catalog}
        rows={mergedRows}
        activeDatasetLabel={activeDataset?.label ?? "Active Run"}
        onClose={() => setActiveRunbookId(null)}
        onSelectScenario={handleJumpToScenario}
        onTestRunbookInWorkbench={handleLoadRunbookInWorkbench}
      />

      <CommandPalette
        open={paletteOpen}
        theme={theme}
        activeDatasetLabel={activeDataset?.label ?? "Active Run"}
        catalog={catalog}
        scenarios={mergedRows}
        onClose={() => setPaletteOpen(false)}
        onSwitchView={(view) => {
          setActiveView(view);
          setMobileNavOpen(false);
        }}
        onToggleTheme={handleToggleTheme}
        onLoadPreset={handleLoadPreset}
        onOpenRunbook={(runbookId) => {
          setActiveView("security");
          setActiveRunbookId(runbookId);
          setMobileNavOpen(false);
        }}
        onSelectScenario={handleJumpToScenario}
      />
    </div>
  );
}
