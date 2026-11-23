"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { AgentGateMark } from "@/components/AgentGateMark";
import { CommandPalette } from "@/components/CommandPalette";
import {
  LiveTriageWorkbench,
  type LiveTriageCustomRequest,
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
import { TRIAGE_PRESETS } from "@/lib/triageCatalog";

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
    if (lowered.includes(svc)) {
      return svc;
    }
  }
  if (expectedRunbook && Object.hasOwn(SERVICE_BY_RUNBOOK, expectedRunbook)) {
    return SERVICE_BY_RUNBOOK[expectedRunbook] ?? "checkout-api";
  }
  return "edge-node-2";
}

function extractP95FromPayload(payloadText: string): number | null {
  const match = payloadText.match(/\bp95(?:\s+latency)?[:\s=]+(\d+(?:\.\d+)?)\s*ms\b/i);
  if (!match?.[1]) {
    return null;
  }
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function ScoreboardApp({ datasets, scenarios, catalog }: ScoreboardAppProps) {
  const [uploadedDatasets, setUploadedDatasets] = useState<readonly RunDataset[]>([]);
  const allDatasets = useMemo(
    () => [...datasets, ...uploadedDatasets],
    [datasets, uploadedDatasets],
  );

  const [activeView, setActiveView] = useState<NavView>("triage");
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [mobileNavOpen, setMobileNavOpen] = useState<boolean>(false);
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
      } else if (event.key === "Escape" && mobileNavOpen) {
        setMobileNavOpen(false);
      }
    }
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [mobileNavOpen]);

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

  const handleStatusSync = useCallback(
    (status: { liveAiConfigured: boolean; claimedKeyCount: number }) => {
      setLiveStatus(status);
    },
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
      const inferredService = inferServiceFromPayload(
        row.payload_text,
        row.expected_runbook,
        catalog.knownServices,
      );
      const inferredP95 = extractP95FromPayload(row.payload_text);
      setCustomRequest({
        nonce: requestNonceRef.current,
        service: inferredService,
        p95Ms: inferredP95,
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
      const budget =
        Object.hasOwn(catalog.serviceBudgetsMs, service)
          ? catalog.serviceBudgetsMs[service] ?? catalog.defaultBudgetMs
          : catalog.defaultBudgetMs;
      const breachedP95 = Math.round(budget * 3.2);
      const cleanLogs =
        Object.hasOwn(catalog.defaultLogs, service) ? catalog.defaultLogs[service] ?? [] : [];
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

  const handleOpenRunbookFromPalette = useCallback((runbookId: string) => {
    setActiveView("security");
    setActiveRunbookId(runbookId);
    setMobileNavOpen(false);
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
        `File "${file.name}" is ${(file.size / (1024 * 1024)).toFixed(2)} MB, exceeding the 2.00 MB limit.`,
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

  const netDeltaPct =
    summary &&
    summary.p95ToolNetMs !== null &&
    summary.p95BaselineNetMs !== null &&
    summary.p95BaselineNetMs > 0
      ? ((summary.p95ToolNetMs - summary.p95BaselineNetMs) / summary.p95BaselineNetMs) * 100
      : null;

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
    {
      key: "benchmarks",
      label: "Eval Benchmarks",
      count: report ? report.results.length : scenarios.length,
    },
    { key: "security", label: "Runbook Catalog", count: catalogRunbooks.length },
  ];

  function renderSidebarContent(isDrawer: boolean) {
    return (
      <div className="flex h-full flex-col justify-between p-4">
        <div className="space-y-6">
          <div className="flex items-center justify-between gap-2">
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
                <div className="text-[14px] font-semibold tracking-tight text-[var(--text)]">
                  AgentGate
                </div>
                <div className="text-[12px] text-[var(--muted)]">prod-eu-west · v2 HMAC</div>
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
            <div className="mb-1.5 px-2 text-[13px] text-[var(--muted)]">Workspace</div>
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
                      className={`flex h-9 w-full items-center justify-between rounded-[6px] border-l-2 px-2.5 text-[14px] transition-colors ${
                        active
                          ? "border-[var(--accent)] bg-[var(--active)] font-medium text-[var(--text)]"
                          : "border-transparent text-[var(--muted)] hover:bg-[var(--raised)] hover:text-[var(--text)]"
                      }`}
                    >
                      <span>{item.label}</span>
                      <span className="num text-[13px] text-[var(--muted)]">{item.count}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div>
            <div className="mb-1.5 px-2 text-[13px] text-[var(--muted)]">Incident queue</div>
            <ul className="space-y-1">
              {TRIAGE_PRESETS.map((preset) => (
                <li key={preset.id}>
                  <button
                    type="button"
                    onClick={() => handleLoadPreset(preset.id)}
                    className="flex w-full items-center justify-between rounded-[6px] px-2.5 py-1.5 text-left text-[13px] text-[var(--muted)] transition-colors hover:bg-[var(--raised)] hover:text-[var(--text)]"
                  >
                    <code className="truncate font-medium text-[var(--text)]">{preset.service}</code>
                    <span className="num shrink-0 text-[12px] text-[var(--muted)]">
                      {preset.p95Ms !== null ? `${preset.p95Ms} ms` : "bait"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="space-y-2 border-t border-[var(--border)] pt-3 text-[13px]">
          <div className="flex items-center justify-between text-[var(--muted)]">
            <span>MCP catalog</span>
            <span className="num text-[var(--text)]">3 read-only tools</span>
          </div>
          <div className="flex items-center justify-between text-[var(--muted)]">
            <span>Ledger keys</span>
            <span className="num text-[var(--text)]">{liveStatus.claimedKeyCount} claimed</span>
          </div>
          {report && (
            <div className="flex items-center justify-between text-[var(--muted)]">
              <span>CI quality gate</span>
              <span
                className="font-medium"
                style={{ color: gatePassed ? "var(--positive)" : "var(--negative)" }}
              >
                {gatePassed ? "Pass" : "Fail"} ({formatPercent(report.tool_pass_rate)})
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh bg-[var(--ground)] text-[var(--text)]">
      {/* Desktop L-Frame / Ruled Left Sidebar */}
      <aside className="hidden w-[224px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--ground)] lg:flex">
        {renderSidebarContent(false)}
      </aside>

      {/* Mobile / Tablet Slide-Over Navigation Sheet */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-40 flex bg-black/60 lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        >
          <aside
            className="h-full w-[264px] border-r border-[var(--border-strong)] bg-[var(--ground)]"
            onClick={(e) => e.stopPropagation()}
          >
            {renderSidebarContent(true)}
          </aside>
        </div>
      )}

      {/* Main Column: 48px Top Bar + Workspace Sheet */}
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
              <span className="font-medium text-[var(--text)]">
                {viewTitleBreadcrumb}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-keyshortcuts="Meta+k Control+k"
            aria-label="Open command palette"
            className="hidden h-8 min-w-0 flex-1 max-w-[380px] items-center justify-between rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--muted)] transition-colors hover:border-[var(--control)] hover:text-[var(--text)] md:inline-flex"
          >
            <span className="truncate">Jump to incident, runbook, or eval...</span>
            <kbd className="ml-2 shrink-0 rounded-[4px] border border-[var(--border-strong)] bg-[var(--raised)] px-1.5 py-0.5 text-[12px] text-[var(--text)]">
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
              className="hidden h-8 items-center rounded-[4px] px-2.5 text-[12px] font-medium sm:inline-flex"
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
              className="inline-flex h-8 items-center rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--raised)]"
            >
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </button>
          </div>
        </header>

        {/* Framed Workspace Sheet (white inset sheet on light, deep ground canvas on dark) */}
        <main
          className={`min-w-0 flex-1 p-4 sm:p-6 ${
            theme === "light"
              ? "border-t border-[var(--border)] bg-[var(--surface)] lg:mb-2 lg:mr-2 lg:rounded-[16px] lg:border"
              : "border-t border-[var(--border)] bg-[var(--ground)]"
          }`}
        >
          <div className="mx-auto max-w-[1200px]">
            {/* View 1: Live Triage Workbench (kept mounted so session delivery log persists) */}
            <div className={activeView === "triage" ? "block" : "hidden"}>
              <LiveTriageWorkbench
                presetRequest={presetRequest}
                customRequest={customRequest}
                onInspectRunbook={(runbookId) => setActiveRunbookId(runbookId)}
                onStatusSync={handleStatusSync}
              />
            </div>

            {/* View 2: Eval Benchmarks */}
            {activeView === "benchmarks" && (
              <div className="space-y-6">
                {!activeDataset || !report || !summary ? (
                  <section className="rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-[14px] text-[var(--muted)]">
                    No evaluation report loaded.
                  </section>
                ) : (
                  <>
                    {/* Title Row */}
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                      <div>
                        <h1 className="text-[24px] font-semibold tracking-tight text-[var(--text)]">
                          Eval Benchmarks
                        </h1>
                        <p className="mt-1 text-[14px] text-[var(--muted)]">
                          MCP tool grounding lifted accuracy from{" "}
                          {formatPercent(report.baseline_pass_rate)} to{" "}
                          {formatPercent(report.tool_pass_rate)} across {summary.totalCases}{" "}
                          scenarios
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
                                onClick={() => handleSelectRun(dataset.id)}
                                className={`-mb-px border-b px-3 py-1.5 font-medium transition-colors ${
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
                          onChange={handleReportUpload}
                          className="hidden"
                        />
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="h-8 rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--raised)]"
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

                    {/* 1px-Divided 5-Cell KPI Strip */}
                    <section
                      aria-label="Evaluation benchmark metrics"
                      className="grid grid-cols-2 divide-y divide-[var(--border)] rounded-[6px] border border-[var(--border)] bg-[var(--surface)] lg:grid-cols-5 lg:divide-x lg:divide-y-0"
                    >
                      <div className="p-4">
                        <div className="text-[13px] text-[var(--muted)]">MCP pass rate</div>
                        <div className="num mt-1 text-[20px] font-semibold tracking-tight text-[var(--text)] sm:text-[24px]">
                          {formatPercent(report.tool_pass_rate)}
                        </div>
                        <div className="num mt-0.5 text-[12px]" style={{ color: passDeltaColor }}>
                          {formatSignedPp(passDelta)} vs {formatPercent(report.baseline_pass_rate)}
                        </div>
                      </div>

                      <div className="p-4">
                        <div className="text-[13px] text-[var(--muted)]">
                          {summary.p95ToolNetMs !== null ? "Net p95 latency" : "Tool p95 latency"}
                        </div>
                        <div className="num mt-1 text-[20px] font-semibold tracking-tight text-[var(--text)] sm:text-[24px]">
                          {formatMs(
                            summary.p95ToolNetMs !== null
                              ? summary.p95ToolNetMs
                              : report.p95_tool_latency_ms,
                          )}
                        </div>
                        <div className="num mt-0.5 text-[12px] text-[var(--muted)]">
                          {summary.p95BaselineNetMs !== null
                            ? `vs ${formatMs(summary.p95BaselineNetMs)} base net`
                            : `Wall p95 ${formatMs(report.p95_tool_latency_ms)}`}
                        </div>
                      </div>

                      <div className="p-4">
                        <div className="text-[13px] text-[var(--muted)]">Schema validity</div>
                        <div className="num mt-1 text-[20px] font-semibold tracking-tight text-[var(--text)] sm:text-[24px]">
                          {formatPercent(report.schema_valid_rate)}
                        </div>
                        <div className="num mt-0.5 text-[12px] text-[var(--muted)]">
                          {summary.schemaValidCount} of {summary.totalCases} valid
                        </div>
                      </div>

                      <div className="p-4">
                        <div className="text-[13px] text-[var(--muted)]">Injection defense</div>
                        <div className="num mt-1 text-[20px] font-semibold tracking-tight text-[var(--text)] sm:text-[24px]">
                          {formatPercent(report.injection_block_rate)}
                        </div>
                        <div className="num mt-0.5 text-[12px] text-[var(--muted)]">
                          {summary.adversarialTotal > 0
                            ? `${summary.adversarialBlocked} of ${summary.adversarialTotal} blocked`
                            : `${injectionFailedRows.length} exposed`}
                        </div>
                      </div>

                      <div className="col-span-2 p-4 lg:col-span-1">
                        <div className="text-[13px] text-[var(--muted)]">CI quality gate</div>
                        <div
                          className="mt-1 text-[20px] font-semibold tracking-tight sm:text-[24px]"
                          style={{ color: gatePassed ? "var(--positive)" : "var(--negative)" }}
                        >
                          {gatePassed ? "Pass" : "Blocked"}
                        </div>
                        <div className="num mt-0.5 text-[12px] text-[var(--muted)]">
                          {gateChecks.filter((c) => c.passed).length} of {gateChecks.length} checks
                        </div>
                      </div>
                    </section>

                    {/* Balanced 2/3 + 1/3 Chart & Gate Ledger Row */}
                    <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-12">
                      <div className="lg:col-span-8">
                        <PairedEvalChart
                          rows={mergedRows}
                          latencyGateMs={activeDataset.latencyGateMs}
                          totalTokens={summary.totalTokens}
                          selectedScenarioId={selectedScenarioId}
                          onSelectScenario={(scenarioId) =>
                            handleSelectScenario(scenarioId, false)
                          }
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
                              className="rounded-[4px] px-2 py-0.5 text-[12px] font-medium"
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
                                className="flex items-center justify-between gap-2 py-2.5 text-[13px]"
                              >
                                <div>
                                  <div className="font-medium text-[var(--text)]">
                                    {check.label}
                                  </div>
                                  <div className="num text-[12px] text-[var(--muted)]">
                                    Floor {check.target}
                                  </div>
                                </div>
                                <div className="text-right">
                                  <div className="num font-medium text-[var(--text)]">
                                    {check.measured}
                                  </div>
                                  <div
                                    className="text-[12px] font-medium"
                                    style={{
                                      color: check.passed
                                        ? "var(--positive)"
                                        : "var(--negative)",
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
                                <span className="num text-[var(--negative)]">
                                  Blocked 0.90 &lt; 0.95
                                </span>
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

                          {report.gate_failures.length > 0 && (
                            <div
                              className="mt-2 rounded-[4px] px-2.5 py-2 text-[11px]"
                              style={{
                                backgroundColor: "var(--pill-negative-bg)",
                                color: "var(--pill-negative-ink)",
                              }}
                            >
                              {report.gate_failures[0]}
                            </div>
                          )}
                        </div>
                      </section>
                    </div>

                    {selectedDetailRow && (
                      <div ref={detailPanelRef} id="scenario-detail">
                        <ScenarioDetailPanel
                          row={selectedDetailRow}
                          onClose={() => setSelectedScenarioId(null)}
                          onLoadInWorkbench={handleLoadScenarioInWorkbench}
                        />
                      </div>
                    )}

                    {/* Rules-and-Alignment Scenario Matrix */}
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
                                className={`-mb-px border-b px-3 py-2 font-medium transition-colors ${
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
                          <label htmlFor="scenario-search" className="sr-only">
                            Filter scenarios
                          </label>
                          <input
                            id="scenario-search"
                            type="search"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search ID, title, or runbook..."
                            className="h-8 w-56 rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--text)] placeholder:text-[var(--faint)]"
                          />

                          <label htmlFor="scenario-sort" className="sr-only">
                            Sort scenarios
                          </label>
                          <select
                            id="scenario-sort"
                            value={sortBy}
                            onChange={(e) => setSortBy(e.target.value as SortOption)}
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
                            <tr className="border-b border-[var(--border)] text-[12px] text-[var(--muted)]">
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
                                <td
                                  colSpan={8}
                                  className="py-8 text-center text-[13px] text-[var(--muted)]"
                                >
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
                                    onClick={() => handleSelectScenario(row.scenario_id, true)}
                                    className={`cursor-pointer transition-colors ${
                                      isSelected ? "bg-[var(--active)]" : "hover:bg-[var(--raised)]"
                                    }`}
                                  >
                                    <td className="py-2.5 pr-3">
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleSelectScenario(row.scenario_id, true);
                                        }}
                                        aria-expanded={isSelected}
                                        className="flex items-center gap-2 text-left"
                                      >
                                        <code className="text-[12px] font-medium text-[var(--accent)]">
                                          {row.scenario_id}
                                        </code>
                                        <span className="font-medium text-[var(--text)]">
                                          {row.title}
                                        </span>
                                      </button>
                                    </td>
                                    <td className="py-2.5 pr-3">
                                      <span
                                        className="inline-flex rounded-[4px] px-2 py-0.5 text-[11px] font-medium"
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
                                        <code className="text-[12px] text-[var(--text)]">
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
                                          handleLoadScenarioInWorkbench(row);
                                        }}
                                        className="rounded-[4px] border border-[var(--control)] bg-[var(--raised)] px-2 py-1 text-[11px] font-medium text-[var(--text)] hover:bg-[var(--active)]"
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
                  </>
                )}
              </div>
            )}

            {/* View 3: Runbook Catalog & Adversarial Security */}
            {activeView === "security" && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-[24px] font-semibold tracking-tight text-[var(--text)]">
                    Runbook Catalog &amp; Security
                  </h1>
                  <p className="mt-1 text-[14px] text-[var(--muted)]">
                    {runbookCards.length} canonical read-only MCP runbooks and{" "}
                    {summary?.adversarialTotal ?? 0} adversarial prompt-injection probes across{" "}
                    {serviceBudgets.length} monitored services.
                  </p>
                </div>

                {/* Balanced 2-Column Row: 8 Runbooks Left vs Stacked Audit + Service Budgets Right */}
                <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-12">
                  {/* Left: 8 Runbooks List */}
                  <section className="rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-5 lg:col-span-6">
                    <div className="flex items-center justify-between gap-2 border-b border-[var(--rule)] pb-3">
                      <h2 className="text-[16px] font-semibold text-[var(--text)]">
                        Verified MCP runbook coverage
                      </h2>
                      <span className="num text-[12px] text-[var(--muted)]">
                        {runbookCards.length} runbooks
                      </span>
                    </div>

                    <div className="mt-2 divide-y divide-[var(--rule)]">
                      {runbookCards.map((item) => {
                        const stats = item.stats;
                        const passRatio =
                          stats && stats.total > 0 ? stats.toolPassed / stats.total : 0;
                        const targetService =
                          Object.hasOwn(SERVICE_BY_RUNBOOK, item.runbookId)
                            ? SERVICE_BY_RUNBOOK[item.runbookId] ?? "checkout-api"
                            : "checkout-api";
                        return (
                          <div
                            key={item.runbookId}
                            className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <code className="text-[12px] font-semibold text-[var(--accent)]">
                                  {item.runbookId}
                                </code>
                                <code className="rounded-[4px] bg-[var(--raised)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]">
                                  {item.symptomTag}
                                </code>
                              </div>
                              <div className="mt-1 truncate text-[13px] font-medium text-[var(--text)]">
                                {item.title}
                              </div>
                              <div className="mt-1.5 flex items-center gap-3">
                                <div className="h-1 w-28 overflow-hidden rounded-full bg-[var(--raised)]">
                                  <div
                                    className="h-full"
                                    style={{
                                      width: `${stats ? Math.round(passRatio * 100) : 0}%`,
                                      backgroundColor:
                                        passRatio >= 1
                                          ? "var(--positive)"
                                          : "var(--negative)",
                                    }}
                                  />
                                </div>
                                <span className="num text-[11px] text-[var(--muted)]">
                                  {stats
                                    ? `${stats.toolPassed}/${stats.total} passed · ${formatMs(stats.avgToolMs)}`
                                    : "0 scenarios matched"}
                                </span>
                              </div>
                            </div>

                            <div className="flex shrink-0 items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setActiveRunbookId(item.runbookId)}
                                className="h-7 rounded-[4px] border border-[var(--control)] bg-[var(--surface)] px-2.5 text-[11px] font-medium text-[var(--text)] hover:bg-[var(--raised)]"
                              >
                                Inspect
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  handleLoadRunbookInWorkbench(targetService, item.symptomTag)
                                }
                                className="h-7 rounded-[4px] border border-[var(--border)] bg-[var(--raised)] px-2.5 text-[11px] font-medium text-[var(--text)] hover:bg-[var(--active)]"
                              >
                                Test
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>

                  {/* Right Column: Stacked Adversarial Audit + SLA Budget Strip to balance height */}
                  <div className="flex flex-col justify-between gap-6 lg:col-span-6">
                    <section className="rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-5">
                      <div className="flex items-center justify-between gap-2 border-b border-[var(--rule)] pb-3">
                        <h2 className="text-[16px] font-semibold text-[var(--text)]">
                          Prompt-injection security probes
                        </h2>
                        <span
                          className="num rounded-[4px] px-2 py-0.5 text-[11px] font-medium"
                          style={{
                            backgroundColor:
                              report && report.injection_block_rate >= 1
                                ? "var(--pill-positive-bg)"
                                : "var(--pill-negative-bg)",
                            color:
                              report && report.injection_block_rate >= 1
                                ? "var(--pill-positive-ink)"
                                : "var(--pill-negative-ink)",
                          }}
                        >
                          {summary && summary.adversarialTotal > 0
                            ? `${summary.adversarialBlocked}/${summary.adversarialTotal} blocked`
                            : `${formatPercent(report?.injection_block_rate ?? 0)}`}
                        </span>
                      </div>

                      {adversarialRows.length === 0 ? (
                        <div className="mt-3 rounded-[6px] border border-dashed border-[var(--control)] bg-[var(--raised)] p-5 text-center text-[13px] text-[var(--muted)]">
                          No matching adversarial scenario IDs in the active dataset.
                        </div>
                      ) : (
                        <div className="mt-2 divide-y divide-[var(--rule)]">
                          {adversarialRows.map((row) => (
                            <div
                              key={row.scenario_id}
                              className="flex items-center justify-between gap-3 py-2.5"
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <code className="shrink-0 whitespace-nowrap text-[12px] font-medium text-[var(--accent)]">
                                    {row.scenario_id}
                                  </code>
                                  <span className="min-w-0 truncate text-[13px] font-medium text-[var(--text)]">
                                    {row.title}
                                  </span>
                                </div>
                                <div className="mt-0.5 text-[12px] text-[var(--muted)]">
                                  Expected {row.expected_severity ?? "-"}{" "}
                                  {row.expected_runbook ?? "null"} · MCP{" "}
                                  {row.tool_severity ?? "-"} {row.tool_runbook ?? "null"}
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                <span
                                  className="rounded-[4px] px-2 py-0.5 text-[12px] font-medium"
                                  style={{
                                    backgroundColor: row.injection_blocked
                                      ? "var(--pill-positive-bg)"
                                      : "var(--pill-negative-bg)",
                                    color: row.injection_blocked
                                      ? "var(--pill-positive-ink)"
                                      : "var(--pill-negative-ink)",
                                  }}
                                >
                                  {row.injection_blocked ? "Blocked" : "Exposed"}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => handleLoadScenarioInWorkbench(row)}
                                  className="h-7 rounded-[4px] border border-[var(--border)] bg-[var(--raised)] px-2.5 text-[12px] font-medium text-[var(--text)] hover:bg-[var(--active)]"
                                >
                                  Test
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>

                    <section className="rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-5">
                      <div className="flex items-center justify-between gap-2 border-b border-[var(--rule)] pb-3">
                        <h2 className="text-[16px] font-semibold text-[var(--text)]">
                          Service SLA p95 budgets
                        </h2>
                        <span className="num text-[12px] text-[var(--muted)]">
                          Unlisted fallback {formatMs(catalog.defaultBudgetMs)}
                        </span>
                      </div>
                      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {serviceBudgets.map(([svc, budgetMs]) => (
                          <div
                            key={svc}
                            className="flex items-center justify-between gap-3 rounded-[6px] border border-[var(--border)] bg-[var(--raised)] px-3 py-2 text-[12px]"
                          >
                            <code className="min-w-0 truncate text-[var(--text)]">{svc}</code>
                            <span className="num shrink-0 whitespace-nowrap font-medium text-[var(--muted)]">
                              {formatMs(budgetMs)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </section>
                  </div>
                </div>
              </div>
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
        onOpenRunbook={handleOpenRunbookFromPalette}
        onSelectScenario={handleJumpToScenario}
      />
    </div>
  );
}
