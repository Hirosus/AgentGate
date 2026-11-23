"use client";

import { useRef } from "react";
import {
  formatTriageMs,
  generateFreshKey,
  useTriageWorkbench,
  type LiveTriageCustomRequest,
  type LiveTriagePresetRequest,
} from "@/hooks/useTriageWorkbench";
import { TriageControlBar } from "@/components/triage/TriageControlBar";
import { WebhookLibraryDrawer } from "@/components/triage/WebhookLibraryDrawer";
import { TriageFacetSidebar } from "@/components/triage/TriageFacetSidebar";
import { TriageStreamTable } from "@/components/triage/TriageStreamTable";
import { TriageInspectorPane } from "@/components/triage/TriageInspectorPane";

export type { LiveTriageCustomRequest, LiveTriagePresetRequest };

interface LiveTriageWorkbenchProps {
  readonly presetRequest?: LiveTriagePresetRequest | null;
  readonly customRequest?: LiveTriageCustomRequest | null;
  readonly onInspectRunbook?: (runbookId: string) => void;
  readonly onStatusSync?: (status: {
    readonly liveAiConfigured: boolean;
    readonly claimedKeyCount: number;
  }) => void;
}

export function LiveTriageWorkbench({
  presetRequest,
  customRequest,
  onInspectRunbook,
  onStatusSync,
}: LiveTriageWorkbenchProps) {
  const libraryButtonRef = useRef<HTMLButtonElement>(null);
  const wb = useTriageWorkbench({ presetRequest, customRequest, onStatusSync });
  const isBusy = wb.bannerState.kind === "dispatching";
  const isResetting = wb.bannerState.kind === "resetting";

  const selectedIndex = wb.filteredStreamEntries.findIndex(
    (e) => e.id === wb.selectedEntry.id,
  );
  const stepSelection = (delta: number) => {
    if (wb.filteredStreamEntries.length === 0) return;
    const nextIdx = Math.max(
      0,
      Math.min(wb.filteredStreamEntries.length - 1, selectedIndex + delta),
    );
    const target = wb.filteredStreamEntries[nextIdx];
    if (target) wb.setSelectedStreamId(target.id);
  };

  return (
    <div className="space-y-3.5">
      {/* Compact Top Operational Header */}
      <div className="flex flex-col justify-between gap-3 border-b border-[var(--border)] pb-3 lg:flex-row lg:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1
              className="text-[24px] font-semibold text-[var(--text)]"
              style={{ letterSpacing: "-0.02em" }}
            >
              Incident Triage
            </h1>
            <span className="rounded-[4px] border border-[var(--border)] bg-[var(--raised)] px-2 py-0.5 text-[13px] font-medium text-[var(--muted)]">
              v2 HMAC · MCP Stdio Gate
            </span>
          </div>
          <p className="mt-0.5 text-[13px] text-[var(--muted)]">
            {wb.selectedEntry.response.httpStatus === 401
              ? `401 Rejected on ${wb.selectedEntry.service}: ${wb.selectedEntry.response.reason}`
              : `${wb.selectedEntry.service} · ${formatTriageMs(wb.slaInfo.p95Ms)} (${wb.slaInfo.ratio}x of ${formatTriageMs(wb.slaInfo.budgetMs)} SLO) \u2192 ${wb.selectedEntry.response.mcpOutput?.severity ?? "halted"} / ${wb.selectedEntry.response.mcpOutput?.recommendedRunbook ?? "null"}`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="num inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--muted)]">
            Claimed keys:
            <strong className="font-semibold text-[var(--text)]">
              {wb.claimedKeyCount}
            </strong>
          </span>
          <span className="num inline-flex h-8 items-center rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--muted)]">
            {wb.liveDispatchedCount} recorded
          </span>
          <button
            type="button"
            disabled={isResetting}
            onClick={() => void wb.resetLedger()}
            className="h-8 rounded-[6px] border border-[var(--border)] bg-[var(--raised)] px-3 text-[13px] font-medium text-[var(--text)] hover:bg-[var(--active)] disabled:opacity-50"
          >
            {isResetting ? "Resetting..." : "Reset keys"}
          </button>
          <button
            type="button"
            disabled={isBusy || !wb.payloadText.trim()}
            onClick={() => void wb.executeWebhookDispatch()}
            className="h-8 rounded-[6px] bg-[var(--primary)] px-4 text-[13px] font-semibold text-[var(--primary-ink)] hover:opacity-90 disabled:opacity-50"
          >
            {isBusy ? "Dispatching..." : "Dispatch webhook"}
          </button>
        </div>
      </div>

      {(wb.bannerState.kind === "error" || wb.bannerState.kind === "notice") && (
        <div
          role="status"
          className="flex items-center justify-between rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-[13px]"
        >
          <span
            className={
              wb.bannerState.kind === "error"
                ? "text-[var(--negative)]"
                : "text-[var(--text)]"
            }
          >
            {wb.bannerState.message}
          </span>
          <button
            type="button"
            onClick={() => wb.setBannerState({ kind: "idle" })}
            className="text-[13px] text-[var(--muted)] hover:text-[var(--text)]"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* OpenStatus Semantic 5-Cell Summary Band (1px Divided — Zero Nested Boxes) */}
      <div className="grid grid-cols-2 divide-y divide-[var(--border)] overflow-hidden rounded-[8px] border border-[var(--border)] bg-[var(--surface)] lg:grid-cols-5 lg:divide-x lg:divide-y-0">
        {(
          [
            {
              id: "accepted" as const,
              label: "Accepted (200)",
              dot: "var(--positive)",
              value: String(wb.streamCounts.accepted),
              sub: "v2 HMAC & 3 MCP tools",
              subColor: "var(--positive)",
            },
            {
              id: "duplicate" as const,
              label: "Deduplicated",
              dot: "var(--phase-cyan)",
              value: String(wb.streamCounts.duplicate),
              sub: "0 redundant tokens burned",
              subColor: "var(--phase-cyan)",
            },
            {
              id: "rejected" as const,
              label: "Rejected (401)",
              dot: "var(--negative)",
              value: String(wb.streamCounts.rejected),
              sub: "Tamper & 300s skew blocked",
              subColor: "var(--negative)",
            },
            {
              id: "bait" as const,
              label: "Injection Guard",
              dot: "var(--warning)",
              value: "Clean",
              sub: `${wb.streamCounts.bait} override probes stripped`,
              subColor: "var(--warning)",
            },
          ] as const
        ).map((card) => (
          <button
            key={card.id}
            type="button"
            onClick={() =>
              wb.setStatusFilter(wb.statusFilter === card.id ? "all" : card.id)
            }
            className={`flex flex-col justify-between p-3 text-left ${
              wb.statusFilter === card.id ? "bg-[var(--raised)]" : "hover:bg-[var(--raised)]"
            }`}
          >
            <div className="flex w-full items-center justify-between text-[13px] text-[var(--muted)]">
              <span>{card.label}</span>
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: card.dot }} />
            </div>
            <div className="num mt-1 text-[20px] font-semibold text-[var(--text)]">
              {card.value}
            </div>
            <div className="mt-0.5 text-[13px]" style={{ color: card.subColor }}>
              {card.sub}
            </div>
          </button>
        ))}

        <div className="col-span-2 flex flex-col justify-between p-3 lg:col-span-1">
          <div className="flex items-center justify-between gap-2 text-[13px] text-[var(--muted)]">
            <span className="whitespace-nowrap">Observed p95</span>
            <code className="shrink-0 whitespace-nowrap text-[13px] text-[var(--accent)]">
              {wb.selectedEntry.service}
            </code>
          </div>
          <div className="num mt-1 text-[20px] font-semibold text-[var(--text)]">
            {formatTriageMs(wb.slaInfo.p95Ms)}
          </div>
          <div
            className="num mt-0.5 text-[13px] font-medium"
            style={{ color: wb.slaInfo.breached ? "var(--negative)" : "var(--positive)" }}
          >
            {wb.slaInfo.ratio}x of {formatTriageMs(wb.slaInfo.budgetMs)} budget
          </div>
        </div>
      </div>

      {/* Progressive-Disclosed Control Bar: Presets + Webhook Library (8) + Fault Mode */}
      <TriageControlBar
        selectedLibraryId={wb.selectedLibraryId}
        fault={wb.fault}
        setFault={wb.setFault}
        mode={wb.mode}
        setMode={wb.setMode}
        liveAiConfigured={wb.liveAiConfigured}
        loading={isBusy}
        libraryButtonRef={libraryButtonRef}
        setLibraryDrawerOpen={wb.setLibraryDrawerOpen}
        setLibraryTab={wb.setLibraryTab}
        onSelectLibraryItem={wb.selectLibraryItem}
        onFireLibraryItem={wb.fireLibraryItem}
      />

      {/* ABOVE-THE-FOLD: Edge-to-Edge OpenStatus 3-Pane Stream & Timing Waterfall Inspector */}
      <section className="overflow-hidden rounded-[8px] border border-[var(--border)] bg-[var(--surface)]">
        <div
          className={`grid grid-cols-1 divide-y divide-[var(--border)] ${
            wb.showFacetSidebar
              ? "xl:grid-cols-[205px_minmax(0,1fr)_420px] xl:divide-x xl:divide-y-0"
              : "xl:grid-cols-[minmax(0,1fr)_420px] xl:divide-x xl:divide-y-0"
          }`}
        >
          {wb.showFacetSidebar && (
            <TriageFacetSidebar
              statusFilter={wb.statusFilter}
              setStatusFilter={wb.setStatusFilter}
              serviceFilter={wb.serviceFilter}
              setServiceFilter={wb.setServiceFilter}
              hasActiveFilters={
                wb.statusFilter !== "all" ||
                wb.serviceFilter !== "all" ||
                wb.providerFilter !== "all" ||
                Boolean(wb.streamSearch)
              }
              onResetFilters={() => {
                wb.setStatusFilter("all");
                wb.setServiceFilter("all");
                wb.setProviderFilter("all");
                wb.setStreamSearch("");
              }}
              totalEntriesCount={wb.allStreamEntries.length}
              counts={wb.streamCounts}
              knownServices={wb.knownServices}
              timingPhases={wb.timingPhases}
            />
          )}

          <TriageStreamTable
            allEntries={wb.allStreamEntries}
            filteredEntries={wb.filteredStreamEntries}
            selectedEntry={wb.selectedEntry}
            onSelectEntry={wb.setSelectedStreamId}
            showFacetSidebar={wb.showFacetSidebar}
            onToggleFacetSidebar={() => wb.setShowFacetSidebar((v) => !v)}
            streamSearch={wb.streamSearch}
            setStreamSearch={wb.setStreamSearch}
            slaInfo={wb.slaInfo}
          />

          <TriageInspectorPane
            selectedEntry={wb.selectedEntry}
            timingPhases={wb.timingPhases}
            curlSnippet={wb.curlSnippet}
            pythonSnippet={wb.pythonSnippet}
            selectedIndexInFiltered={selectedIndex}
            filteredCount={wb.filteredStreamEntries.length}
            loading={isBusy}
            onStepSelection={stepSelection}
            onReplaySelected={wb.executeWebhookDispatch}
            onInspectRunbook={onInspectRunbook}
            onGenerateReplayKey={generateFreshKey}
          />
        </div>
      </section>

      {/* Progressive-Disclosed Slide-Over Hookdeck Webhook Library & Custom Payload Drawer */}
      <WebhookLibraryDrawer
        open={wb.libraryDrawerOpen}
        onClose={() => wb.setLibraryDrawerOpen(false)}
        returnFocusRef={libraryButtonRef}
        activeTab={wb.libraryTab}
        setActiveTab={wb.setLibraryTab}
        originUrl={wb.originUrl}
        providerFilter={wb.providerFilter}
        setProviderFilter={wb.setProviderFilter}
        selectedLibraryId={wb.selectedLibraryId}
        onSelectLibraryItem={wb.selectLibraryItem}
        onFireLibraryItem={wb.fireLibraryItem}
        service={wb.service}
        setService={wb.setService}
        p95Input={wb.p95Input}
        setP95Input={wb.setP95Input}
        idempotencyKey={wb.idempotencyKey}
        setIdempotencyKey={wb.setIdempotencyKey}
        payloadText={wb.payloadText}
        setPayloadText={wb.setPayloadText}
        knownServices={wb.knownServices}
        loading={isBusy}
        onSendCustom={() => wb.executeWebhookDispatch()}
      />
    </div>
  );
}
