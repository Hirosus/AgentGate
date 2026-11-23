"use client";

import { useRef, type KeyboardEvent } from "react";
import { getServiceSlaInfo, type ServiceSlaInfo } from "@/lib/triagePreview";
import { formatTriageMs, type StreamDeliveryEntry } from "@/hooks/useTriageWorkbench";

interface TriageStreamTableProps {
  readonly allEntries: ReadonlyArray<StreamDeliveryEntry>;
  readonly filteredEntries: ReadonlyArray<StreamDeliveryEntry>;
  readonly selectedEntry: StreamDeliveryEntry;
  readonly onSelectEntry: (id: string) => void;
  readonly showFacetSidebar: boolean;
  readonly onToggleFacetSidebar: () => void;
  readonly streamSearch: string;
  readonly setStreamSearch: (q: string) => void;
  readonly slaInfo: ServiceSlaInfo;
}

export function TriageStreamTable({
  allEntries,
  filteredEntries,
  selectedEntry,
  onSelectEntry,
  showFacetSidebar,
  onToggleFacetSidebar,
  streamSearch,
  setStreamSearch,
  slaInfo,
}: TriageStreamTableProps) {
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());

  const handleRowKeyDown = (
    e: KeyboardEvent<HTMLTableRowElement>,
    idx: number,
  ) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") {
      return;
    }
    e.preventDefault();
    const nextIdx =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? filteredEntries.length - 1
          : e.key === "ArrowDown"
            ? Math.min(filteredEntries.length - 1, idx + 1)
            : Math.max(0, idx - 1);
    const nextEntry = filteredEntries[nextIdx];
    if (!nextEntry) return;
    onSelectEntry(nextEntry.id);
    window.requestAnimationFrame(() => rowRefs.current.get(nextEntry.id)?.focus());
  };

  return (
    <div className="flex min-w-0 flex-col justify-between bg-[var(--surface)]">
      <div>
        {/* Controls & Accessible Live Filter Count */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-3.5 py-2.5">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onToggleFacetSidebar}
              className="h-7 rounded-[4px] border border-[var(--border)] bg-[var(--raised)] px-2.5 text-[13px] font-medium text-[var(--text)] hover:bg-[var(--active)]"
            >
              {showFacetSidebar ? "Hide Controls" : "Show Controls"}
            </button>
            <span
              aria-live="polite"
              className="num text-[13px] text-[var(--muted)]"
            >
              <strong className="text-[var(--text)]">{filteredEntries.length}</strong>{" "}
              of {allEntries.length} row(s) filtered
            </span>
          </div>

          <input
            type="search"
            value={streamSearch}
            onChange={(e) => setStreamSearch(e.target.value)}
            placeholder="Search host, key, or runbook..."
            aria-label="Search webhook delivery stream"
            className="h-7 w-56 rounded-[4px] border border-[var(--control)] bg-[var(--ground)] px-2.5 text-[13px] text-[var(--text)] placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:outline-none"
          />
        </div>

        {/* Tufte / OpenStatus Distribution Histogram */}
        <div className="border-b border-[var(--border)] bg-[var(--ground)] px-4 py-2.5">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-[13px] text-[var(--muted)]">
            <span>SLO latency &amp; gate histogram (use ↑/↓ keys or click bar)</span>
            <span className="num">
              <code className="text-[var(--text)]">{selectedEntry.service}</code> ·{" "}
              {formatTriageMs(slaInfo.p95Ms)} / {formatTriageMs(slaInfo.budgetMs)} (
              {slaInfo.ratio}x)
            </span>
          </div>
          <div className="flex h-10 items-end gap-1.5 pt-1">
            {allEntries.map((entry) => {
              const info = getServiceSlaInfo(entry.service, entry.p95Ms);
              const heightPct = Math.max(18, Math.min(100, Math.round((info.ratio / 5) * 100)));
              const isActive = entry.id === selectedEntry.id;
              const barColor =
                entry.response.httpStatus === 401
                  ? "var(--negative)"
                  : entry.response.webhookStatus === "duplicate"
                    ? "var(--phase-cyan)"
                    : info.ratio >= 3
                      ? "var(--negative)"
                      : info.ratio > 1
                        ? "var(--warning)"
                        : "var(--positive)";
              return (
                <button
                  key={entry.id}
                  type="button"
                  aria-label={`Select ${entry.service} ${entry.p95Ms}ms event`}
                  onClick={() => onSelectEntry(entry.id)}
                  className={`flex h-full flex-1 items-end rounded-[2px] bg-[var(--surface)] p-0.5 ${
                    isActive ? "ring-1 ring-[var(--accent)]" : ""
                  }`}
                >
                  <span
                    className="w-full rounded-[2px] transition-opacity"
                    style={{
                      height: `${heightPct}%`,
                      backgroundColor: barColor,
                      opacity: isActive ? 1 : 0.72,
                    }}
                  />
                </button>
              );
            })}
          </div>
        </div>

        {/* WAI-ARIA Roving Tabindex High-Density Table */}
        <div className="overflow-x-auto">
          <table
            role="grid"
            aria-label="Inbound webhook deliveries"
            aria-rowcount={filteredEntries.length}
            className="w-full border-collapse text-left"
          >
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--ground)] text-[13px] font-medium text-[var(--muted)]">
                <th scope="col" className="w-8 py-2 pl-3.5 pr-1">Lv</th>
                <th scope="col" className="py-2 pr-2">Time / Mode</th>
                <th scope="col" className="py-2 pr-2">Status</th>
                <th scope="col" className="py-2 pr-2">Method</th>
                <th scope="col" className="py-2 pr-2">Host</th>
                <th scope="col" className="py-2 pr-2">Pathname</th>
                <th scope="col" className="py-2 pr-2 text-right">p95</th>
                <th scope="col" className="py-2 pr-3.5 text-right">Verdict</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--rule)] text-[13px]">
              {filteredEntries.map((entry, idx) => {
                const isSelected = entry.id === selectedEntry.id;
                const entryVerdict = entry.response.mcpOutput;
                const statusColor =
                  entry.response.httpStatus === 401
                    ? "var(--negative)"
                    : entry.response.webhookStatus === "duplicate"
                      ? "var(--phase-cyan)"
                      : entry.response.injectionDetected
                        ? "var(--warning)"
                        : "var(--positive)";
                const statusLabel =
                  entry.response.httpStatus === 401
                    ? "401"
                    : entry.response.webhookStatus === "duplicate"
                      ? "200 DUP"
                      : "200";

                return (
                  <tr
                    key={entry.id}
                    ref={(el) => {
                      if (el) rowRefs.current.set(entry.id, el);
                      else rowRefs.current.delete(entry.id);
                    }}
                    role="row"
                    aria-selected={isSelected}
                    tabIndex={isSelected || (idx === 0 && !filteredEntries.some((e) => e.id === selectedEntry.id)) ? 0 : -1}
                    onKeyDown={(e) => handleRowKeyDown(e, idx)}
                    onClick={() => onSelectEntry(entry.id)}
                    className={`cursor-pointer focus:outline-none focus-visible:bg-[var(--active)] ${
                      isSelected ? "bg-[var(--active)]" : "hover:bg-[var(--raised)]"
                    }`}
                  >
                    <td className="py-2.5 pl-3.5 pr-1">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-[2px]"
                        style={{ backgroundColor: statusColor }}
                      />
                    </td>
                    <td className="num whitespace-nowrap py-2.5 pr-2 text-[13px] text-[var(--muted)]">
                      {entry.isLiveDispatched ? (
                        <span className="font-semibold text-[var(--text)]">
                          {entry.timestampLabel}
                        </span>
                      ) : (
                        <span>{entry.timestampLabel}</span>
                      )}
                    </td>
                    <td
                      className="num code-id whitespace-nowrap py-2.5 pr-2 text-[13px] font-semibold"
                      style={{ color: statusColor }}
                    >
                      {statusLabel}
                    </td>
                    <td className="code-id whitespace-nowrap py-2.5 pr-2 text-[13px] text-[var(--muted)]">
                      POST
                    </td>
                    <td className="code-id whitespace-nowrap py-2.5 pr-2 text-[13px] font-medium text-[var(--text)]">
                      {entry.service}
                    </td>
                    <td className="code-id max-w-[175px] truncate py-2.5 pr-2 text-[13px] text-[var(--muted)]">
                      {entry.pathname}
                    </td>
                    <td className="num code-id whitespace-nowrap py-2.5 pr-2 text-right text-[13px] text-[var(--text)]">
                      {formatTriageMs(entry.p95Ms)}
                    </td>
                    <td className="code-id whitespace-nowrap py-2.5 pr-3.5 text-right text-[13px]">
                      {entry.response.httpStatus === 401 ? (
                        <span className="text-[var(--negative)]">gate_halted</span>
                      ) : entry.response.webhookStatus === "duplicate" ? (
                        <span style={{ color: "var(--phase-cyan)" }}>
                          idempotent_skip
                        </span>
                      ) : (
                        <span className="text-[var(--accent)]">
                          {entryVerdict?.recommendedRunbook ?? "low / null"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Stephen Few Bullet Graph (Context against Service SLO Target) */}
      <div className="border-t border-[var(--border)] bg-[var(--ground)] p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
          <span className="font-semibold text-[var(--text)]">
            SLA bullet track (
            <code className="text-[var(--accent)]">{selectedEntry.service}</code>)
          </span>
          <span className="num text-[var(--muted)]">
            Observed {formatTriageMs(slaInfo.p95Ms)} · SLO{" "}
            {formatTriageMs(slaInfo.budgetMs)} · Ratio{" "}
            <strong className="text-[var(--text)]">{slaInfo.ratio}x</strong>
          </span>
        </div>
        <div className="relative mt-2 h-2.5 w-full overflow-hidden rounded-[3px] bg-[var(--surface)]">
          <div
            className="absolute top-0 bottom-0 w-px bg-[var(--text)] opacity-60"
            style={{ left: "20%" }}
          />
          <div
            className="absolute top-0 bottom-0 w-px bg-[var(--warning)] opacity-85"
            style={{ left: "60%" }}
          />
          <div
            className="h-full rounded-[3px]"
            style={{
              width: `${Math.max(4, Math.min(100, (slaInfo.ratio / 5) * 100))}%`,
              backgroundColor:
                slaInfo.ratio >= 3
                  ? "var(--negative)"
                  : slaInfo.ratio > 1
                    ? "var(--warning)"
                    : "var(--positive)",
            }}
          />
        </div>
        <div className="num mt-1.5 flex flex-wrap justify-between gap-2 text-[13px] text-[var(--muted)]">
          <span>0 ms</span>
          <span>1x SLO ({formatTriageMs(slaInfo.budgetMs)})</span>
          <span>3x High ({formatTriageMs(slaInfo.budgetMs * 3)})</span>
          <span>5x Critical ({formatTriageMs(slaInfo.budgetMs * 5)})</span>
        </div>
      </div>
    </div>
  );
}
