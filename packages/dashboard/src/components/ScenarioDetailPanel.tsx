"use client";

import {
  formatInt,
  formatMs,
  type MergedCaseRow,
} from "@/lib/evalData";

interface ScenarioDetailPanelProps {
  readonly row: MergedCaseRow;
  readonly onClose: () => void;
}

export function ScenarioDetailPanel({ row, onClose }: ScenarioDetailPanelProps) {
  return (
    <aside
      aria-label={`Details for ${row.scenario_id}`}
      className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-[4px] bg-[var(--raised)] px-2 py-0.5 text-[12px] font-medium text-[var(--text)]">
              {row.scenario_id}
            </code>
            <span
              className="inline-flex items-center rounded-[4px] px-2 py-0.5 text-[12px] font-medium"
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
            {row.is_adversarial_injection && (
              <span
                className="inline-flex items-center rounded-[4px] px-2 py-0.5 text-[12px] font-medium"
                style={{
                  backgroundColor: "var(--pill-warning-bg)",
                  color: "var(--pill-warning-ink)",
                }}
              >
                Adversarial probe
              </span>
            )}
          </div>
          <h3 className="mt-2 text-[16px] font-semibold text-[var(--text)]">{row.title}</h3>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="h-8 rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-3 text-[12px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--raised)]"
        >
          Close
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <div className="text-[12px] font-medium text-[var(--muted)]">
            Untrusted inbound alert payload
          </div>
          <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap rounded-[6px] border border-[var(--border)] bg-[var(--raised)] p-3 text-[12px] leading-relaxed text-[var(--text)]">
            {row.payload_text}
          </pre>
        </div>

        <div className="grid grid-cols-2 gap-3 rounded-[6px] border border-[var(--border)] bg-[var(--raised)] p-3.5 text-[13px] lg:col-span-5">
          <div>
            <div className="text-[12px] text-[var(--muted)]">Expected severity</div>
            <div className="mt-0.5 font-medium text-[var(--text)]">
              {row.expected_severity ?? "-"}
            </div>
          </div>
          <div>
            <div className="text-[12px] text-[var(--muted)]">Expected runbook</div>
            <div className="mt-0.5">
              {row.expected_runbook ? (
                <code className="text-[12px] text-[var(--text)]">{row.expected_runbook}</code>
              ) : (
                <span className="text-[var(--muted)]">None</span>
              )}
            </div>
          </div>
          <div>
            <div className="text-[12px] text-[var(--muted)]">Baseline outcome</div>
            <div className="num mt-0.5 font-medium text-[var(--text)]">
              {row.baseline_passed ? "Pass" : "Fail"} ({formatMs(row.baseline_latency_ms)})
            </div>
          </div>
          <div>
            <div className="text-[12px] text-[var(--muted)]">MCP tool outcome</div>
            <div className="num mt-0.5 font-medium text-[var(--text)]">
              {row.tool_passed ? "Pass" : "Fail"} ({formatMs(row.tool_latency_ms)})
            </div>
          </div>
          <div>
            <div className="text-[12px] text-[var(--muted)]">Schema valid</div>
            <div className="mt-0.5 font-medium text-[var(--text)]">
              {row.tool_schema_valid ? "Yes" : "No"}
            </div>
          </div>
          <div>
            <div className="text-[12px] text-[var(--muted)]">Token spend</div>
            <div className="num mt-0.5 font-medium text-[var(--text)]">
              {row.total_tokens > 0 ? `${formatInt(row.total_tokens)} tok` : "0 tok"}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
