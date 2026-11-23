"use client";

import type { Dispatch, RefObject, SetStateAction } from "react";
import type { EngineMode, FaultMode } from "@/lib/triageCatalog";
import { WEBHOOK_LIBRARY_ITEMS, type WebhookLibraryItem } from "@/lib/triagePreview";

interface TriageControlBarProps {
  readonly selectedLibraryId: string;
  readonly fault: FaultMode;
  readonly setFault: (fault: FaultMode) => void;
  readonly mode: EngineMode;
  readonly setMode: (mode: EngineMode) => void;
  readonly liveAiConfigured: boolean;
  readonly loading: boolean;
  readonly libraryButtonRef: RefObject<HTMLButtonElement | null>;
  readonly setLibraryDrawerOpen: Dispatch<SetStateAction<boolean>>;
  readonly setLibraryTab: Dispatch<SetStateAction<"library" | "custom">>;
  readonly onSelectLibraryItem: (item: WebhookLibraryItem) => void;
  readonly onFireLibraryItem: (item: WebhookLibraryItem) => Promise<void>;
}

const FAULT_MODES: ReadonlyArray<{ readonly id: FaultMode; readonly label: string }> = [
  { id: "valid", label: "Valid v2" },
  { id: "duplicate_replay", label: "Duplicate" },
  { id: "tamper_body", label: "Tamper 401" },
  { id: "stale_timestamp", label: "Stale 401" },
];

export function TriageControlBar({
  selectedLibraryId,
  fault,
  setFault,
  mode,
  setMode,
  liveAiConfigured,
  loading,
  libraryButtonRef,
  setLibraryDrawerOpen,
  setLibraryTab,
  onSelectLibraryItem,
  onFireLibraryItem,
}: TriageControlBarProps) {
  const quickPresets = WEBHOOK_LIBRARY_ITEMS.slice(0, 4);

  return (
    <div className="flex flex-col justify-between gap-2.5 rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 xl:flex-row xl:items-center">
      {/* Left: Hookdeck Quick Provider Triggers + Full Library Drawer Button */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[13px] font-medium text-[var(--muted)]">
          Webhook presets:
        </span>
        {quickPresets.map((item) => {
          const active = selectedLibraryId === item.id;
          return (
            <div
              key={item.id}
              className={`inline-flex items-center overflow-hidden rounded-[6px] border text-[13px] ${
                active
                  ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                  : "border-[var(--border)] bg-[var(--ground)]"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectLibraryItem(item)}
                className="flex h-7 items-center gap-1.5 px-2.5 font-medium text-[var(--text)] hover:bg-[var(--raised)]"
              >
                <span className="code-id text-[13px] text-[var(--accent)]">
                  {item.service}
                </span>
                <span className="num text-[13px] text-[var(--muted)]">
                  {item.p95Ms}ms
                </span>
              </button>
              <button
                type="button"
                disabled={loading}
                aria-label={`Send ${item.title}`}
                onClick={() => void onFireLibraryItem(item)}
                className="h-7 border-l border-[var(--border)] bg-[var(--raised)] px-2 text-[13px] font-medium text-[var(--text)] hover:bg-[var(--primary)] hover:text-[var(--primary-ink)] disabled:opacity-50"
              >
                Send
              </button>
            </div>
          );
        })}

        <button
          ref={libraryButtonRef}
          type="button"
          onClick={() => {
            setLibraryTab("library");
            setLibraryDrawerOpen(true);
          }}
          className="inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-[var(--control)] bg-[var(--raised)] px-2.5 text-[13px] font-medium text-[var(--text)] hover:bg-[var(--active)]"
        >
          <span>Webhook Library</span>
          <span className="num text-[13px] text-[var(--accent)]">
            ({WEBHOOK_LIBRARY_ITEMS.length})
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            setLibraryTab("custom");
            setLibraryDrawerOpen(true);
          }}
          className="inline-flex h-7 items-center rounded-[6px] border border-[var(--border)] bg-[var(--ground)] px-2.5 text-[13px] font-medium text-[var(--muted)] hover:bg-[var(--raised)] hover:text-[var(--text)]"
        >
          Custom Payload
        </button>
      </div>

      {/* Right: Fault Mode & Execution Engine */}
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="Webhook delivery simulation mode"
          className="inline-flex flex-wrap rounded-[6px] border border-[var(--border)] bg-[var(--ground)] p-0.5"
        >
          {FAULT_MODES.map((fm) => {
            const active = fault === fm.id;
            return (
              <button
                key={fm.id}
                type="button"
                onClick={() => setFault(fm.id)}
                className={`rounded-[4px] px-2.5 py-1 text-[13px] font-medium ${
                  active
                    ? "bg-[var(--raised)] text-[var(--text)]"
                    : "text-[var(--muted)] hover:text-[var(--text)]"
                }`}
              >
                {fm.label}
              </button>
            );
          })}
        </div>

        <div
          role="group"
          aria-label="Triage execution engine"
          className="inline-flex rounded-[6px] border border-[var(--border)] bg-[var(--ground)] p-0.5"
        >
          <button
            type="button"
            onClick={() => setMode("deterministic_mcp")}
            className={`rounded-[4px] px-2.5 py-1 text-[13px] font-medium ${
              mode === "deterministic_mcp"
                ? "bg-[var(--raised)] text-[var(--text)]"
                : "text-[var(--muted)] hover:text-[var(--text)]"
            }`}
          >
            Instant MCP
          </button>
          <button
            type="button"
            onClick={() => setMode("live_ai")}
            className={`rounded-[4px] px-2.5 py-1 text-[13px] font-medium ${
              mode === "live_ai"
                ? "bg-[var(--raised)] text-[var(--text)]"
                : "text-[var(--muted)] hover:text-[var(--text)]"
            }`}
          >
            {liveAiConfigured ? "Live Gemini" : "Live AI (Fallback)"}
          </button>
        </div>
      </div>
    </div>
  );
}
