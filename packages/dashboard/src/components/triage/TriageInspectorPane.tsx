"use client";

import { useState } from "react";
import type { TimingPhaseBar, WebhookProviderId } from "@/lib/triagePreview";
import type { FaultMode } from "@/lib/triageCatalog";
import type { StreamDeliveryEntry } from "@/hooks/useTriageWorkbench";

type InspectorTab = "headers" | "diff" | "curl" | "python";

interface TriageInspectorPaneProps {
  readonly selectedEntry: StreamDeliveryEntry;
  readonly timingPhases: ReadonlyArray<TimingPhaseBar>;
  readonly curlSnippet: string;
  readonly pythonSnippet: string;
  readonly selectedIndexInFiltered: number;
  readonly filteredCount: number;
  readonly loading: boolean;
  readonly onStepSelection: (delta: number) => void;
  readonly onReplaySelected: (override: {
    readonly service: string;
    readonly p95Ms: number;
    readonly payloadText: string;
    readonly idempotencyKey: string;
    readonly fault: FaultMode;
    readonly providerId: WebhookProviderId;
    readonly providerLabel: string;
    readonly eventType: string;
    readonly pathname: string;
  }) => Promise<void>;
  readonly onInspectRunbook?: (runbookId: string) => void;
  readonly onGenerateReplayKey: (service: string) => string;
}

export function TriageInspectorPane({
  selectedEntry,
  timingPhases,
  curlSnippet,
  pythonSnippet,
  selectedIndexInFiltered,
  filteredCount,
  loading,
  onStepSelection,
  onReplaySelected,
  onInspectRunbook,
  onGenerateReplayKey,
}: TriageInspectorPaneProps) {
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("headers");
  const [expandedToolIdx, setExpandedToolIdx] = useState<number | null>(0);
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);

  const res = selectedEntry.response;
  const verdict = res.mcpOutput;
  const baseline = res.baselineOutput;

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedLabel(label);
      setTimeout(() => setCopiedLabel(null), 1600);
    } catch {
      setCopiedLabel(null);
    }
  };

  return (
    <aside className="flex flex-col justify-between bg-[var(--ground)] p-4">
      <div className="space-y-4">
        {/* Sticky Inspector Title + Up/Down Steppers + Replay */}
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] pb-2.5">
          <code className="truncate text-[14px] font-semibold text-[var(--text)]">
            {selectedEntry.pathname}
          </code>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label="Previous delivery"
              disabled={selectedIndexInFiltered <= 0}
              onClick={() => onStepSelection(-1)}
              className="h-7 w-7 rounded-[4px] border border-[var(--border)] bg-[var(--raised)] text-[13px] text-[var(--text)] hover:bg-[var(--active)] disabled:opacity-40"
            >
              &uarr;
            </button>
            <button
              type="button"
              aria-label="Next delivery"
              disabled={
                selectedIndexInFiltered < 0 ||
                selectedIndexInFiltered >= filteredCount - 1
              }
              onClick={() => onStepSelection(1)}
              className="h-7 w-7 rounded-[4px] border border-[var(--border)] bg-[var(--raised)] text-[13px] text-[var(--text)] hover:bg-[var(--active)] disabled:opacity-40"
            >
              &darr;
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() =>
                void onReplaySelected({
                  service: selectedEntry.service,
                  p95Ms: selectedEntry.p95Ms,
                  payloadText: selectedEntry.payloadText,
                  idempotencyKey: onGenerateReplayKey(selectedEntry.service),
                  fault: selectedEntry.fault,
                  providerId: selectedEntry.providerId,
                  providerLabel: selectedEntry.providerLabel,
                  eventType: selectedEntry.eventType,
                  pathname: selectedEntry.pathname,
                })
              }
              className="ml-1 h-7 rounded-[4px] border border-[var(--border)] bg-[var(--raised)] px-2.5 text-[13px] font-semibold text-[var(--text)] hover:bg-[var(--active)]"
            >
              Replay
            </button>
          </div>
        </div>

        {/* Unboxed OpenStatus-Style Key-Value Metadata Grid */}
        <div className="divide-y divide-[var(--border)] border-y border-[var(--border)] text-[13px]">
          <div className="flex items-center justify-between gap-2 py-1.5">
            <span className="text-[var(--muted)]">Execution</span>
            <span className="font-medium text-[var(--text)]">
              {selectedEntry.isLiveDispatched
                ? `Live dispatched · ${selectedEntry.timestampLabel}`
                : "Preview snapshot · 0 keys claimed"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 py-1.5">
            <span className="shrink-0 text-[var(--muted)]">Idempotency Key</span>
            <code className="truncate text-[13px] text-[var(--text)]">
              {selectedEntry.idempotencyKey}
            </code>
          </div>
          <div className="flex items-center justify-between gap-2 py-1.5">
            <span className="text-[var(--muted)]">Status &amp; Gate</span>
            <code
              className="num font-semibold"
              style={{
                color: res.httpStatus === 200 ? "var(--positive)" : "var(--negative)",
              }}
            >
              {res.httpStatus} {res.webhookStatus.toUpperCase()} ({res.totalLatencyMs}ms)
            </code>
          </div>
          <div className="flex items-center justify-between gap-2 py-1.5">
            <span className="text-[var(--muted)]">Baseline Heuristic</span>
            <code className="text-[13px] text-[var(--muted)]">
              {baseline
                ? `${baseline.severity} / ${baseline.recommendedRunbook ?? "null"}`
                : "not_run"}
            </code>
          </div>
          <div className="flex items-center justify-between gap-2 py-1.5">
            <span className="text-[var(--muted)]">MCP Verdict</span>
            <div className="flex items-center gap-2">
              <code className="font-semibold text-[var(--positive)]">
                {verdict
                  ? `${verdict.severity} / ${verdict.recommendedRunbook ?? "null"}`
                  : "halted_at_gate"}
              </code>
              {verdict?.recommendedRunbook && onInspectRunbook && (
                <button
                  type="button"
                  onClick={() => onInspectRunbook(verdict.recommendedRunbook!)}
                  className="rounded-[4px] border border-[var(--border)] bg-[var(--raised)] px-2 py-0.5 text-[13px] font-medium text-[var(--accent)] hover:bg-[var(--active)]"
                >
                  Runbook
                </button>
              )}
            </div>
          </div>
        </div>

        {/* OpenStatus Timing Phases Proportional Waterfall */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-[13px]">
            <span className="font-semibold text-[var(--text)]">Timing Phases</span>
            <span className="num text-[var(--muted)]">{res.totalLatencyMs}ms total</span>
          </div>
          <div className="space-y-2 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-3">
            {timingPhases.map((phase) => {
              const barWidth =
                phase.status === "skipped"
                  ? 4
                  : Math.max(10, Math.min(100, phase.sharePct));
              return (
                <div key={phase.id} className="space-y-0.5">
                  <div className="grid grid-cols-[130px_46px_1fr] items-center gap-2 text-[13px]">
                    <code className="truncate font-semibold text-[var(--text)]">
                      {phase.codeLabel}
                    </code>
                    <span className="num text-right text-[var(--muted)]">
                      {phase.sharePct}%
                    </span>
                    <div className="flex items-center justify-end gap-2">
                      <span className="num text-[var(--text)]">{phase.durationMs}ms</span>
                      <div className="flex h-3 w-20 justify-end overflow-hidden rounded-[2px] bg-[var(--ground)]">
                        <div
                          className="h-full rounded-[2px]"
                          style={{
                            width: `${barWidth}%`,
                            backgroundColor: phase.colorVar,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="truncate text-[13px] text-[var(--muted)]">
                    {phase.detail}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* MCP Diagnostic Tool Calls */}
        {res.toolTraces.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[13px]">
              <span className="font-semibold text-[var(--text)]">
                MCP Tool Calls ({res.toolTraces.length})
              </span>
              <span className="text-[var(--muted)]">read-only sandbox</span>
            </div>
            <div className="space-y-1.5">
              {res.toolTraces.map((trace, idx) => {
                const expanded = expandedToolIdx === idx;
                return (
                  <div
                    key={`${trace.toolName}-${idx}`}
                    className="rounded-[6px] border border-[var(--border)] bg-[var(--surface)]"
                  >
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setExpandedToolIdx(expanded ? null : idx)}
                      className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left text-[13px] hover:bg-[var(--raised)]"
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <code className="font-semibold text-[var(--accent)]">
                          {trace.toolName}
                        </code>
                        {trace.untrustedDataFlag && (
                          <span
                            className="whitespace-nowrap rounded-[4px] px-1.5 py-0.5 text-[13px] font-medium"
                            style={{
                              backgroundColor: "var(--pill-warning-bg)",
                              color: "var(--pill-warning-ink)",
                            }}
                          >
                            untrustedTelemetry: true
                          </span>
                        )}
                      </div>
                      <span className="num shrink-0 text-[13px] text-[var(--muted)]">
                        {trace.durationMs}ms · {expanded ? "Hide" : "Inspect"}
                      </span>
                    </button>
                    {expanded && (
                      <div className="border-t border-[var(--rule)] p-2.5">
                        <pre className="max-h-24 overflow-auto text-[13px] text-[var(--text)]">
                          {JSON.stringify(trace.result, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Headers & Wire Diff / SDK Tabs */}
        <div>
          <div className="mb-2 flex flex-wrap gap-1 border-b border-[var(--border)] pb-1.5">
            {(
              [
                { id: "headers", label: "Headers" },
                { id: "diff", label: "Wire body diff" },
                { id: "curl", label: "cURL (v2 HMAC)" },
                { id: "python", label: "Python SDK" },
              ] as const
            ).map((tab) => {
              const active = inspectorTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setInspectorTab(tab.id)}
                  className={`rounded-[4px] px-2 py-1 text-[13px] font-medium ${
                    active
                      ? "bg-[var(--raised)] text-[var(--text)]"
                      : "text-[var(--muted)] hover:text-[var(--text)]"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {inspectorTab === "headers" && (
            <div className="divide-y divide-[var(--border)] rounded-[6px] border border-[var(--border)] bg-[var(--surface)] text-[13px]">
              {Object.entries(res.requestEnvelope.headers).map(([k, v]) => (
                <div key={k} className="grid grid-cols-[140px_1fr] gap-2 px-3 py-1.5">
                  <code className="truncate text-[var(--muted)]">{k}</code>
                  <code className="truncate text-[var(--text)]">{v}</code>
                </div>
              ))}
            </div>
          )}

          {inspectorTab === "diff" && (
            <div className="space-y-2 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-3 text-[13px]">
              <div className="text-[var(--muted)]">
                Signed rawBody ({res.requestEnvelope.rawBody.length}B)
              </div>
              <pre className="overflow-x-auto rounded-[4px] bg-[var(--ground)] p-2 text-[13px] text-[var(--text)]">
                {res.requestEnvelope.rawBody}
              </pre>
              <div className="text-[var(--muted)]">
                Received wireBody ({res.requestEnvelope.wireBody.length}B)
              </div>
              <pre className="overflow-x-auto rounded-[4px] bg-[var(--ground)] p-2 text-[13px] text-[var(--text)]">
                {res.requestEnvelope.wireBody}
              </pre>
            </div>
          )}

          {inspectorTab === "curl" && (
            <div className="rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-3 text-[13px]">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[var(--muted)]">Signed v2 cURL</span>
                <button
                  type="button"
                  onClick={() => void handleCopy(curlSnippet, "cURL")}
                  className="rounded-[4px] border border-[var(--border)] bg-[var(--raised)] px-2 py-0.5 text-[13px] font-medium text-[var(--text)]"
                >
                  {copiedLabel === "cURL" ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="max-h-32 overflow-auto rounded-[4px] bg-[var(--ground)] p-2 text-[13px] text-[var(--text)]">
                {curlSnippet}
              </pre>
            </div>
          )}

          {inspectorTab === "python" && (
            <div className="rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-3 text-[13px]">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[var(--muted)]">AgentGateClient Python SDK</span>
                <button
                  type="button"
                  onClick={() => void handleCopy(pythonSnippet, "Python")}
                  className="rounded-[4px] border border-[var(--border)] bg-[var(--raised)] px-2 py-0.5 text-[13px] font-medium text-[var(--text)]"
                >
                  {copiedLabel === "Python" ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="max-h-32 overflow-auto rounded-[4px] bg-[var(--ground)] p-2 text-[13px] text-[var(--text)]">
                {pythonSnippet}
              </pre>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
