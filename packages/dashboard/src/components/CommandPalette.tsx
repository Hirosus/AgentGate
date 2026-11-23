"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { McpCatalog, MergedCaseRow } from "@/lib/evalData";
import { TRIAGE_PRESETS } from "@/lib/triageCatalog";

export type PaletteView = "triage" | "benchmarks" | "security";

interface CommandPaletteProps {
  readonly open: boolean;
  readonly theme: "dark" | "light";
  readonly activeDatasetLabel: string;
  readonly catalog: McpCatalog;
  readonly scenarios: readonly MergedCaseRow[];
  readonly onClose: () => void;
  readonly onSwitchView: (view: PaletteView) => void;
  readonly onToggleTheme: () => void;
  readonly onLoadPreset: (presetId: string) => void;
  readonly onOpenRunbook: (runbookId: string) => void;
  readonly onSelectScenario: (scenarioId: string) => void;
}

interface PaletteItem {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly subtitle: string;
  readonly badge?: string;
  readonly keywords: string;
  readonly run: () => void;
}

export function CommandPalette({
  open,
  theme,
  activeDatasetLabel,
  catalog,
  scenarios,
  onClose,
  onSwitchView,
  onToggleTheme,
  onLoadPreset,
  onOpenRunbook,
  onSelectScenario,
}: CommandPaletteProps) {
  const [query, setQuery] = useState<string>("");
  const [activeIndex, setActiveIndex] = useState<number>(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const optionRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  useEffect(() => {
    if (!open) {
      return;
    }
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActiveIndex(0);
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [open]);

  const dismissPalette = useCallback(() => {
    const returnTarget = previousFocusRef.current;
    onClose();
    window.requestAnimationFrame(() => {
      returnTarget?.focus();
    });
  }, [onClose]);

  const items = useMemo<readonly PaletteItem[]>(() => {
    const viewItems: PaletteItem[] = [
      {
        id: "view-triage",
        group: "Views",
        label: "Incident Triage Workbench",
        subtitle: "Dispatch v2-signed webhooks, inspect 5-stage pipeline and MCP tool calls",
        badge: "View",
        keywords: "live triage webhook hmac idempotency workbench",
        run: () => onSwitchView("triage"),
      },
      {
        id: "view-benchmarks",
        group: "Views",
        label: "Eval Benchmarks & CI Gate",
        subtitle: "Paired latency/token charts, CI quality floors, and scenario explorer",
        badge: "View",
        keywords: "eval benchmarks chart ci gate scenarios",
        run: () => onSwitchView("benchmarks"),
      },
      {
        id: "view-security",
        group: "Views",
        label: "Runbook Catalog & Security",
        subtitle: "Inspect MCP runbooks, SLA budgets, and adversarial injection probes",
        badge: "View",
        keywords: "runbooks security prompt injection audit",
        run: () => onSwitchView("security"),
      },
      {
        id: "toggle-theme",
        group: "Appearance",
        label: theme === "dark" ? "Switch to Framed Sheet (Light)" : "Switch to Data Terminal (Dark)",
        subtitle: "Persist console theme preference in localStorage",
        badge: "Theme",
        keywords: "theme dark light appearance contrast",
        run: () => onToggleTheme(),
      },
    ];

    const presetItems: PaletteItem[] = TRIAGE_PRESETS.map((preset) => ({
      id: `preset-${preset.id}`,
      group: "Triage Presets",
      label: preset.label,
      subtitle: `${preset.service} · ${preset.expectedNote}`,
      badge: preset.isAdversarial ? "Bait" : "Preset",
      keywords: `${preset.id} ${preset.service} ${preset.label} ${preset.expectedNote}`,
      run: () => onLoadPreset(preset.id),
    }));

    const runbookItems: PaletteItem[] = Object.entries(catalog.runbooks)
      .filter(([symptomTag]) => Object.hasOwn(catalog.runbooks, symptomTag))
      .map(([symptomTag, runbook]) => ({
        id: `runbook-${runbook.runbookId}`,
        group: "MCP Runbooks",
        label: `${runbook.runbookId}: ${runbook.title}`,
        subtitle: `${symptomTag} · ${
          Object.hasOwn(catalog.symptomDescriptions, symptomTag)
            ? catalog.symptomDescriptions[symptomTag] ?? ""
            : ""
        }`,
        badge: "Runbook",
        keywords: `${runbook.runbookId} ${runbook.title} ${symptomTag}`,
        run: () => onOpenRunbook(runbook.runbookId),
      }));

    const scenarioItems: PaletteItem[] = scenarios.map((row) => ({
      id: `scenario-${row.scenario_id}`,
      group: `Eval Scenarios (${activeDatasetLabel})`,
      label: `${row.scenario_id}: ${row.title}`,
      subtitle: `${row.expected_runbook ?? "no runbook"} · ${row.tool_passed ? "MCP pass" : "MCP fail"}`,
      badge: row.is_adversarial_injection ? "Adversarial" : "Scenario",
      keywords: `${row.scenario_id} ${row.title} ${row.expected_runbook ?? ""} ${row.tool_runbook ?? ""}`,
      run: () => onSelectScenario(row.scenario_id),
    }));

    return [...viewItems, ...presetItems, ...runbookItems, ...scenarioItems];
  }, [
    activeDatasetLabel,
    catalog,
    onLoadPreset,
    onOpenRunbook,
    onSelectScenario,
    onSwitchView,
    onToggleTheme,
    scenarios,
    theme,
  ]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return items;
    }
    const tokens = q.split(/\s+/).filter(Boolean);
    return items.filter((item) => {
      const haystack = `${item.label} ${item.subtitle} ${item.keywords}`.toLowerCase();
      return tokens.every((tok) => haystack.includes(tok));
    });
  }, [items, query]);

  const clampedIndex =
    filteredItems.length === 0 ? -1 : Math.min(activeIndex, filteredItems.length - 1);

  useEffect(() => {
    if (!open || clampedIndex < 0) {
      return;
    }
    const el = optionRefs.current.get(clampedIndex);
    el?.scrollIntoView({ block: "nearest" });
  }, [clampedIndex, open]);

  const executeItem = useCallback(
    (item: PaletteItem) => {
      onClose();
      item.run();
    },
    [onClose],
  );

  if (!open) {
    return null;
  }

  const activeItem = clampedIndex >= 0 ? filteredItems[clampedIndex] : undefined;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[10vh]"
      onClick={dismissPalette}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            dismissPalette();
            return;
          }
          if (filteredItems.length === 0) {
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((prev) => (prev + 1) % filteredItems.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
          } else if (e.key === "Enter" && activeItem) {
            e.preventDefault();
            executeItem(activeItem);
          }
        }}
        className="w-full max-w-xl overflow-hidden rounded-[8px] border border-[var(--border-strong)] bg-[var(--surface)]"
      >
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
          <label htmlFor="command-palette-input" className="sr-only">
            Search views, presets, runbooks, or scenarios
          </label>
          <input
            ref={inputRef}
            id="command-palette-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-listbox"
            aria-activedescendant={activeItem ? `palette-opt-${activeItem.id}` : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            placeholder="Jump to view, preset, runbook, scenario, or theme..."
            className="w-full bg-transparent text-[14px] text-[var(--text)] placeholder:text-[var(--faint)] focus:outline-none"
          />
          <kbd className="shrink-0 rounded-[4px] border border-[var(--border-strong)] bg-[var(--raised)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--muted)]">
            Esc
          </kbd>
        </div>

        <div
          id="command-palette-listbox"
          role="listbox"
          aria-label="Command results"
          className="max-h-[60vh] overflow-y-auto p-2"
        >
          {filteredItems.length === 0 ? (
            <div className="px-3 py-8 text-center text-[13px] text-[var(--muted)]">
              No matching views, presets, runbooks, or scenarios.
            </div>
          ) : (
            filteredItems.map((item, idx) => {
              const prevGroup = idx > 0 ? filteredItems[idx - 1]?.group : null;
              const showGroupHeader = item.group !== prevGroup;
              const selected = idx === clampedIndex;
              return (
                <div key={item.id}>
                  {showGroupHeader && (
                    <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-[var(--muted)]">
                      {item.group}
                    </div>
                  )}
                  <button
                    ref={(el) => {
                      if (el) {
                        optionRefs.current.set(idx, el);
                      } else {
                        optionRefs.current.delete(idx);
                      }
                    }}
                    id={`palette-opt-${item.id}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => executeItem(item)}
                    className={`flex w-full items-center justify-between gap-3 rounded-[6px] px-3 py-2 text-left transition-colors ${
                      selected ? "bg-[var(--active)]" : "hover:bg-[var(--raised)]"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium text-[var(--text)]">
                        {item.label}
                      </div>
                      <div className="truncate text-[12px] text-[var(--muted)]">
                        {item.subtitle}
                      </div>
                    </div>
                    {item.badge && (
                      <span className="shrink-0 rounded-[4px] border border-[var(--border)] bg-[var(--raised)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted)]">
                        {item.badge}
                      </span>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--rule)] bg-[var(--raised)] px-4 py-2 text-[11px] text-[var(--muted)]">
          <span>Up/Down Navigate · Enter Execute · Esc Close</span>
          <span className="num">{filteredItems.length} commands</span>
        </div>
      </div>
    </div>
  );
}
