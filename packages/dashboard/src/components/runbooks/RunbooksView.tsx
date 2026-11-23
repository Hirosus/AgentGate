"use client";

import {
  formatMs,
  formatPercent,
  type EvalSuiteReport,
  type McpCatalog,
  type MergedCaseRow,
  type RunbookSummary,
  type SummaryMetrics,
} from "@/lib/evalData";

export interface RunbookCardEntry {
  readonly runbookId: string;
  readonly title: string;
  readonly symptomTag: string;
  readonly stats: RunbookSummary | null;
}

interface RunbooksViewProps {
  readonly runbookCards: readonly RunbookCardEntry[];
  readonly adversarialRows: readonly MergedCaseRow[];
  readonly serviceBudgets: readonly (readonly [string, number])[];
  readonly catalog: McpCatalog;
  readonly report: EvalSuiteReport | null;
  readonly summary: SummaryMetrics | null;
  readonly serviceByRunbook: Readonly<Record<string, string>>;
  readonly onInspectRunbook: (runbookId: string) => void;
  readonly onTestRunbookInWorkbench: (service: string, symptomTag: string) => void;
  readonly onLoadScenarioInWorkbench: (row: MergedCaseRow) => void;
}

export function RunbooksView({
  runbookCards,
  adversarialRows,
  serviceBudgets,
  catalog,
  report,
  summary,
  serviceByRunbook,
  onInspectRunbook,
  onTestRunbookInWorkbench,
  onLoadScenarioInWorkbench,
}: RunbooksViewProps) {
  return (
    <div className="space-y-5">
      <div className="border-b border-[var(--border)] pb-3.5">
        <h1 className="text-[24px] font-semibold tracking-tight text-[var(--text)]">
          Runbook Catalog &amp; Security
        </h1>
        <p className="mt-1 text-[13px] text-[var(--muted)]">
          {runbookCards.length} canonical read-only MCP runbooks and{" "}
          {summary?.adversarialTotal ?? 0} adversarial prompt-injection probes across{" "}
          {serviceBudgets.length} monitored services.
        </p>
      </div>

      <div className="grid grid-cols-1 items-stretch gap-5 lg:grid-cols-12">
        <section className="rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-5 lg:col-span-6">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--rule)] pb-3">
            <h2 className="text-[16px] font-semibold text-[var(--text)]">
              Verified MCP runbook coverage
            </h2>
            <span className="num text-[13px] text-[var(--muted)]">
              {runbookCards.length} runbooks
            </span>
          </div>

          <div className="mt-2 divide-y divide-[var(--rule)]">
            {runbookCards.map((item) => {
              const stats = item.stats;
              const passRatio =
                stats && stats.total > 0 ? stats.toolPassed / stats.total : 0;
              const targetService = Object.hasOwn(serviceByRunbook, item.runbookId)
                ? serviceByRunbook[item.runbookId] ?? "checkout-api"
                : "checkout-api";
              return (
                <div
                  key={item.runbookId}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="text-[13px] font-semibold text-[var(--accent)]">
                        {item.runbookId}
                      </code>
                      <code className="rounded-[4px] bg-[var(--raised)] px-1.5 py-0.5 text-[13px] text-[var(--muted)]">
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
                              passRatio >= 1 ? "var(--positive)" : "var(--negative)",
                          }}
                        />
                      </div>
                      <span className="num text-[13px] text-[var(--muted)]">
                        {stats
                          ? `${stats.toolPassed}/${stats.total} passed · ${formatMs(stats.avgToolMs)}`
                          : "0 scenarios matched"}
                      </span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onInspectRunbook(item.runbookId)}
                      className="h-7 rounded-[4px] border border-[var(--control)] bg-[var(--surface)] px-2.5 text-[13px] font-medium text-[var(--text)] hover:bg-[var(--raised)]"
                    >
                      Inspect
                    </button>
                    <button
                      type="button"
                      onClick={() => onTestRunbookInWorkbench(targetService, item.symptomTag)}
                      className="h-7 rounded-[4px] border border-[var(--border)] bg-[var(--raised)] px-2.5 text-[13px] font-medium text-[var(--text)] hover:bg-[var(--active)]"
                    >
                      Test
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <div className="flex flex-col justify-between gap-5 lg:col-span-6">
          <section className="rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-5">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--rule)] pb-3">
              <h2 className="text-[16px] font-semibold text-[var(--text)]">
                Prompt-injection security probes
              </h2>
              <span
                className="num rounded-[4px] px-2 py-0.5 text-[13px] font-medium"
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
                        <code className="shrink-0 whitespace-nowrap text-[13px] font-medium text-[var(--accent)]">
                          {row.scenario_id}
                        </code>
                        <span className="min-w-0 truncate text-[13px] font-medium text-[var(--text)]">
                          {row.title}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[13px] text-[var(--muted)]">
                        Expected {row.expected_severity ?? "-"}{" "}
                        {row.expected_runbook ?? "null"} · MCP{" "}
                        {row.tool_severity ?? "-"} {row.tool_runbook ?? "null"}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span
                        className="rounded-[4px] px-2 py-0.5 text-[13px] font-medium"
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
                        onClick={() => onLoadScenarioInWorkbench(row)}
                        className="h-7 rounded-[4px] border border-[var(--border)] bg-[var(--raised)] px-2.5 text-[13px] font-medium text-[var(--text)] hover:bg-[var(--active)]"
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
              <span className="num text-[13px] text-[var(--muted)]">
                Unlisted fallback {formatMs(catalog.defaultBudgetMs)}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {serviceBudgets.map(([svc, budgetMs]) => (
                <div
                  key={svc}
                  className="flex items-center justify-between gap-3 rounded-[6px] border border-[var(--border)] bg-[var(--raised)] px-3 py-2 text-[13px]"
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
  );
}
