"use client";

import type { TimingPhaseBar } from "@/lib/triagePreview";
import type { StatusFilter } from "@/hooks/useTriageWorkbench";
import { getServiceSlaInfo } from "@/lib/triagePreview";

interface TriageFacetSidebarProps {
  readonly statusFilter: StatusFilter;
  readonly setStatusFilter: (f: StatusFilter) => void;
  readonly serviceFilter: string;
  readonly setServiceFilter: (s: string) => void;
  readonly hasActiveFilters: boolean;
  readonly onResetFilters: () => void;
  readonly totalEntriesCount: number;
  readonly counts: {
    readonly accepted: number;
    readonly duplicate: number;
    readonly rejected: number;
    readonly bait: number;
  };
  readonly knownServices: ReadonlyArray<string>;
  readonly timingPhases: ReadonlyArray<TimingPhaseBar>;
}

export function TriageFacetSidebar({
  statusFilter,
  setStatusFilter,
  serviceFilter,
  setServiceFilter,
  hasActiveFilters,
  onResetFilters,
  totalEntriesCount,
  counts,
  knownServices,
  timingPhases,
}: TriageFacetSidebarProps) {
  return (
    <aside className="flex flex-col justify-between bg-[var(--ground)] p-3.5">
      <div className="space-y-4">
        <div className="flex items-center justify-between border-b border-[var(--border)] pb-2">
          <span className="text-[13px] font-semibold text-[var(--text)]">
            Filters
          </span>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={onResetFilters}
              className="text-[13px] text-[var(--accent)] hover:underline"
            >
              Reset
            </button>
          )}
        </div>

        <div>
          <div className="mb-1.5 text-[13px] font-medium text-[var(--muted)]">
            Gate Level
          </div>
          <div className="space-y-1">
            {(
              [
                {
                  id: "all",
                  label: "All deliveries",
                  color: "var(--muted)",
                  count: totalEntriesCount,
                },
                {
                  id: "accepted",
                  label: "Success 200",
                  color: "var(--positive)",
                  count: counts.accepted,
                },
                {
                  id: "duplicate",
                  label: "Duplicate 200",
                  color: "var(--phase-cyan)",
                  count: counts.duplicate,
                },
                {
                  id: "rejected",
                  label: "Rejected 401",
                  color: "var(--negative)",
                  count: counts.rejected,
                },
                {
                  id: "bait",
                  label: "Bait Blocked",
                  color: "var(--warning)",
                  count: counts.bait,
                },
              ] as const
            ).map((lv) => {
              const active = statusFilter === lv.id;
              return (
                <button
                  key={lv.id}
                  type="button"
                  onClick={() => setStatusFilter(lv.id)}
                  className={`flex w-full items-center justify-between rounded-[4px] px-2 py-1 text-left text-[13px] ${
                    active
                      ? "bg-[var(--raised)] font-semibold text-[var(--text)]"
                      : "text-[var(--muted)] hover:bg-[var(--raised)] hover:text-[var(--text)]"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 rounded-[2px]"
                      style={{ backgroundColor: lv.color }}
                    />
                    <span>{lv.label}</span>
                  </span>
                  <span className="num text-[13px]">{lv.count}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="border-t border-[var(--border)] pt-3">
          <div className="mb-1.5 text-[13px] font-medium text-[var(--muted)]">
            Host Service
          </div>
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => setServiceFilter("all")}
              className={`flex w-full items-center justify-between rounded-[4px] px-2 py-1 text-left text-[13px] ${
                serviceFilter === "all"
                  ? "bg-[var(--raised)] font-semibold text-[var(--text)]"
                  : "text-[var(--muted)] hover:text-[var(--text)]"
              }`}
            >
              <span>All hosts</span>
              <span className="num text-[13px]">{knownServices.length}</span>
            </button>
            {knownServices.slice(0, 6).map((svc) => {
              const active = serviceFilter === svc;
              const budget = getServiceSlaInfo(svc, 0).budgetMs;
              return (
                <button
                  key={svc}
                  type="button"
                  onClick={() => setServiceFilter(active ? "all" : svc)}
                  className={`flex w-full items-center justify-between rounded-[4px] px-2 py-1 text-left text-[13px] ${
                    active
                      ? "bg-[var(--raised)] font-semibold text-[var(--text)]"
                      : "text-[var(--muted)] hover:text-[var(--text)]"
                  }`}
                >
                  <code className="truncate">{svc}</code>
                  <span className="num shrink-0 text-[13px]">{budget}ms</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="border-t border-[var(--border)] pt-3">
          <div className="mb-1.5 text-[13px] font-medium text-[var(--muted)]">
            Timing Phases
          </div>
          <div className="space-y-1.5 text-[13px] text-[var(--muted)]">
            {timingPhases.map((tp) => (
              <div key={tp.id} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="h-2 w-2 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: tp.colorVar }}
                  />
                  <code className="truncate text-[13px]">{tp.codeLabel}</code>
                </span>
                <span className="num shrink-0">{tp.durationMs}ms</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 border-t border-[var(--border)] pt-2.5 text-[13px] text-[var(--muted)]">
        Ledger: <code>SameSite=Strict</code>
      </div>
    </aside>
  );
}
