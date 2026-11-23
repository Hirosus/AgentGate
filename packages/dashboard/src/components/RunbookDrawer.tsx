"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  formatMs,
  type McpCatalog,
  type McpCatalogRunbook,
  type MergedCaseRow,
} from "@/lib/evalData";

interface RunbookDrawerProps {
  readonly runbookId: string | null;
  readonly catalog: McpCatalog;
  readonly rows: readonly MergedCaseRow[];
  readonly activeDatasetLabel: string;
  readonly onClose: () => void;
  readonly onSelectScenario: (scenarioId: string) => void;
  readonly onTestRunbookInWorkbench?: (service: string, symptomTag: string) => void;
}

const PRIMARY_SERVICES_BY_SYMPTOM: Readonly<Record<string, readonly string[]>> = {
  db_pool_exhaustion: ["checkout-api"],
  webhook_timeout: ["payments-worker"],
  auth_failure: ["webhook-ingress"],
  vlan_packet_loss: ["edge-switch-01"],
  tls_cert_expiry: ["auth-gateway"],
  redis_eviction_spike: ["session-cache"],
  dns_resolution_failure: ["core-dns"],
  lambda_oom_throttle: ["triage-lambda"],
};

interface ResolvedCatalogRunbook {
  readonly symptomTag: string;
  readonly entry: McpCatalogRunbook;
  readonly description: string;
  readonly primaryServices: readonly string[];
}

function resolveCatalogRunbook(
  catalog: McpCatalog,
  runbookId: string,
): ResolvedCatalogRunbook | null {
  for (const [symptomTag, entry] of Object.entries(catalog.runbooks)) {
    if (Object.hasOwn(catalog.runbooks, symptomTag) && entry.runbookId === runbookId) {
      const description = Object.hasOwn(catalog.symptomDescriptions, symptomTag)
        ? catalog.symptomDescriptions[symptomTag] ?? ""
        : "";
      const primaryServices = Object.hasOwn(PRIMARY_SERVICES_BY_SYMPTOM, symptomTag)
        ? PRIMARY_SERVICES_BY_SYMPTOM[symptomTag] ?? []
        : [];
      return { symptomTag, entry, description, primaryServices };
    }
  }
  return null;
}

export function RunbookDrawer({
  runbookId,
  catalog,
  rows,
  activeDatasetLabel,
  onClose,
  onSelectScenario,
  onTestRunbookInWorkbench,
}: RunbookDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const restoreFocusOnCloseRef = useRef<boolean>(true);

  const dismissDrawer = useCallback(() => {
    restoreFocusOnCloseRef.current = true;
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!runbookId) {
      return;
    }
    restoreFocusOnCloseRef.current = true;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusTimer = window.setTimeout(() => {
      closeButtonRef.current?.focus();
    }, 0);

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissDrawer();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleKeyDown);
      if (restoreFocusOnCloseRef.current) {
        previousFocusRef.current?.focus();
      }
    };
  }, [runbookId, dismissDrawer]);

  const resolved = useMemo(
    () => (runbookId ? resolveCatalogRunbook(catalog, runbookId) : null),
    [catalog, runbookId],
  );

  const linkedScenarios = useMemo(() => {
    if (!runbookId) {
      return [];
    }
    return rows.filter(
      (row) => row.expected_runbook === runbookId || row.tool_runbook === runbookId,
    );
  }, [rows, runbookId]);

  const serviceBudgets = useMemo(
    () =>
      Object.entries(catalog.serviceBudgetsMs).filter(([svc]) =>
        Object.hasOwn(catalog.serviceBudgetsMs, svc),
      ),
    [catalog.serviceBudgetsMs],
  );

  if (!runbookId) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/60"
      onClick={dismissDrawer}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="runbook-drawer-title"
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-[var(--border-strong)] bg-[var(--surface)] p-6"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--rule)] pb-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <code
                className="rounded-[4px] border border-[var(--border)] bg-[var(--raised)] px-2 py-0.5 text-[12px] font-medium"
                style={{ color: "var(--accent)" }}
              >
                {runbookId}
              </code>
              {resolved && (
                <code
                  className="rounded-[4px] px-2 py-0.5 text-[12px] font-medium"
                  style={{
                    backgroundColor: "var(--pill-accent-bg)",
                    color: "var(--pill-accent-ink)",
                  }}
                >
                  {resolved.symptomTag}
                </code>
              )}
            </div>
            <h2
              id="runbook-drawer-title"
              className="mt-2 text-[18px] font-semibold tracking-tight text-[var(--text)]"
            >
              {resolved ? resolved.entry.title : `Runbook ${runbookId}`}
            </h2>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {resolved && onTestRunbookInWorkbench && resolved.primaryServices[0] && (
              <button
                type="button"
                onClick={() => {
                  restoreFocusOnCloseRef.current = false;
                  onTestRunbookInWorkbench(
                    resolved.primaryServices[0] ?? "checkout-api",
                    resolved.symptomTag,
                  );
                }}
                className="h-8 rounded-[6px] bg-[var(--primary)] px-3 text-[12px] font-medium text-[var(--primary-ink)] transition-opacity hover:opacity-90"
              >
                Load in workbench
              </button>
            )}
            <button
              ref={closeButtonRef}
              type="button"
              onClick={dismissDrawer}
              className="h-8 rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-3 text-[12px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--raised)]"
            >
              Close
            </button>
          </div>
        </div>

        <div className="mt-5 space-y-6">
          {resolved ? (
            <>
              <section aria-label="Symptom disambiguation">
                <h3 className="text-[12px] font-medium text-[var(--muted)]">
                  Symptom disambiguation
                </h3>
                <p className="mt-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--raised)] p-3.5 text-[13px] leading-relaxed text-[var(--text)]">
                  {resolved.description || "Canonical diagnostic runbook in MCP catalog."}
                </p>
              </section>

              <section aria-label="Ordered diagnostic checks">
                <h3 className="text-[12px] font-medium text-[var(--muted)]">
                  Ordered remediation checks ({resolved.entry.checks.length})
                </h3>
                <ol className="mt-2 space-y-2">
                  {resolved.entry.checks.map((check, index) => (
                    <li
                      key={check}
                      className="flex items-start gap-3 rounded-[6px] border border-[var(--border)] bg-[var(--raised)] p-3 text-[13px] text-[var(--text)]"
                    >
                      <span className="num inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--border-strong)] bg-[var(--surface)] text-[11px] font-semibold text-[var(--text)]">
                        {index + 1}
                      </span>
                      <span>{check}</span>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          ) : (
            <div className="rounded-[6px] border border-dashed border-[var(--control)] bg-[var(--raised)] p-4 text-[13px] text-[var(--muted)]">
              This runbook ID does not exist in the local read-only MCP catalog.
            </div>
          )}

          <section aria-label="SLA service budgets">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[12px] font-medium text-[var(--muted)]">
                SLA p95 latency budgets
              </h3>
              <span className="num text-[12px] text-[var(--muted)]">
                Fallback {formatMs(catalog.defaultBudgetMs)}
              </span>
            </div>
            <p className="mt-1 text-[12px] text-[var(--muted)]">
              Ratio calibration: within budget = low, &gt;1x = medium, &gt;=3x = high, &gt;=5x =
              critical.
            </p>
            <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {serviceBudgets.map(([svc, budgetMs]) => {
                const isPrimary = resolved?.primaryServices.includes(svc) ?? false;
                return (
                  <div
                    key={svc}
                    className={`flex items-center justify-between gap-2 rounded-[6px] border px-3 py-2 text-[12px] ${
                      isPrimary
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--border)] bg-[var(--raised)]"
                    }`}
                  >
                    <code className="font-medium text-[var(--text)]">{svc}</code>
                    <span
                      className="num font-semibold"
                      style={{ color: isPrimary ? "var(--accent)" : "var(--muted)" }}
                    >
                      {formatMs(budgetMs)}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          <section aria-label="Linked evaluation scenarios">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[12px] font-medium text-[var(--muted)]">
                Linked scenarios ({activeDatasetLabel})
              </h3>
              <span className="num text-[12px] text-[var(--muted)]">
                {linkedScenarios.length} matched
              </span>
            </div>

            {linkedScenarios.length === 0 ? (
              <div className="mt-2 rounded-[6px] border border-dashed border-[var(--control)] bg-[var(--raised)] p-4 text-[13px] text-[var(--muted)]">
                No scenarios in {activeDatasetLabel} reference this runbook.
              </div>
            ) : (
              <div className="mt-2 space-y-2">
                {linkedScenarios.map((row) => (
                  <button
                    key={row.scenario_id}
                    type="button"
                    onClick={() => {
                      restoreFocusOnCloseRef.current = false;
                      onSelectScenario(row.scenario_id);
                    }}
                    className="flex w-full items-center justify-between gap-3 rounded-[6px] border border-[var(--border)] bg-[var(--raised)] p-3 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--active)]"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <code
                          className="shrink-0 text-[12px] font-medium"
                          style={{ color: "var(--accent)" }}
                        >
                          {row.scenario_id}
                        </code>
                        <span className="truncate text-[13px] font-medium text-[var(--text)]">
                          {row.title}
                        </span>
                      </div>
                      <div className="num mt-1 text-[12px] text-[var(--muted)]">
                        MCP {formatMs(row.tool_latency_ms)} · Baseline{" "}
                        {row.baseline_passed ? "Pass" : "Fail"}
                      </div>
                    </div>
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
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
