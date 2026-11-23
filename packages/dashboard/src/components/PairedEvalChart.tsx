"use client";

import { useState } from "react";
import {
  formatInt,
  formatMs,
  type MergedCaseRow,
} from "@/lib/evalData";

interface PairedEvalChartProps {
  readonly rows: readonly MergedCaseRow[];
  readonly latencyGateMs: number;
  readonly totalTokens: number;
  readonly selectedScenarioId: string | null;
  readonly onSelectScenario: (scenarioId: string) => void;
}

type ChartMetric = "latency" | "tokens";

const STEP_CANDIDATES = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 15000, 20000,
];

function computeYScale(maxRaw: number): { yMax: number; ticks: readonly number[] } {
  const safeMax = maxRaw > 0 ? maxRaw * 1.18 : 10;
  const tickCount = 4;
  const roughStep = safeMax / tickCount;
  const step =
    STEP_CANDIDATES.find((candidate) => candidate >= roughStep) ??
    Math.ceil(roughStep / 5000) * 5000;
  const yMax = step * tickCount;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => i * step);
  return { yMax, ticks };
}

function formatAxisTick(value: number, metric: ChartMetric): string {
  if (value === 0) {
    return "0";
  }
  if (metric === "latency") {
    if (value >= 1000) {
      const k = value / 1000;
      return Number.isInteger(k) ? `${k}s` : `${k.toFixed(1)}s`;
    }
    return `${value}`;
  }
  if (value >= 1000) {
    const k = value / 1000;
    return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return `${value}`;
}

export function PairedEvalChart({
  rows,
  latencyGateMs,
  totalTokens,
  selectedScenarioId,
  onSelectScenario,
}: PairedEvalChartProps) {
  const [metric, setMetric] = useState<ChartMetric>("latency");
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const activeMetric: ChartMetric = totalTokens > 0 ? metric : "latency";

  const values = rows.map((row) =>
    activeMetric === "latency"
      ? Math.max(row.tool_latency_ms, row.baseline_latency_ms)
      : row.total_tokens,
  );
  const rawMax = values.length > 0 ? Math.max(...values) : 10;
  const { yMax, ticks } = computeYScale(rawMax);

  const plotLeft = 48;
  const plotRight = 702;
  const plotTop = 34;
  const plotBottom = 220;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;

  const slotWidth = rows.length > 0 ? plotWidth / rows.length : plotWidth;
  const barWidth = Math.min(20, Math.max(3, slotWidth * 0.54));
  const baselineTickOverhang = Math.min(2, barWidth * 0.35);
  const labelStride = rows.length <= 25 ? 5 : Math.ceil(rows.length / 5);

  const activeId = hoveredId ?? selectedScenarioId ?? rows[0]?.scenario_id ?? null;
  const activeRow = rows.find((row) => row.scenario_id === activeId) ?? rows[0];

  const showGateLine =
    activeMetric === "latency" && latencyGateMs > 0 && latencyGateMs <= yMax;
  const gateY = showGateLine
    ? plotBottom - (latencyGateMs / yMax) * plotHeight
    : null;

  // Identify peak MCP latency/token bar and first adversarial injection bar for leader annotations.
  let peakIdx = -1;
  let peakVal = -1;
  let firstAdvIdx = -1;
  rows.forEach((row, idx) => {
    const val = activeMetric === "latency" ? row.tool_latency_ms : row.total_tokens;
    if (val > peakVal) {
      peakVal = val;
      peakIdx = idx;
    }
    if (firstAdvIdx === -1 && row.is_adversarial_injection) {
      firstAdvIdx = idx;
    }
  });

  const peakRow = peakIdx >= 0 ? rows[peakIdx] : undefined;
  const advRow =
    firstAdvIdx >= 0 && Math.abs(firstAdvIdx - peakIdx) >= 3 ? rows[firstAdvIdx] : undefined;

  return (
    <section className="flex h-full flex-col justify-between rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-5">
      <div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-[16px] font-semibold text-[var(--text)]">
              {activeMetric === "latency"
                ? "Per-scenario latency (MCP vs. baseline)"
                : "Per-scenario token expenditure"}
            </h2>
            <p className="mt-0.5 text-[12px] text-[var(--muted)]">
              {activeMetric === "latency"
                ? `Bars plot MCP latency; horizontal ticks mark baseline. Gate floor <= ${formatMs(latencyGateMs)}.`
                : "Total prompt plus completion tokens across MCP tool turns."}
            </p>
          </div>

          {totalTokens > 0 && (
            <div
              className="inline-flex border-b border-[var(--border)] text-[13px]"
              role="group"
              aria-label="Chart metric"
            >
              {(["latency", "tokens"] as const).map((mode) => {
                const selected = activeMetric === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setMetric(mode)}
                    className={`border-b px-3 py-1.5 font-medium capitalize transition-colors ${
                      selected
                        ? "border-[var(--accent)] text-[var(--text)]"
                        : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
                    }`}
                  >
                    {mode}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-y border-[var(--rule)] py-2 text-[12px]">
          {activeRow ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <code className="font-medium text-[var(--accent)]">{activeRow.scenario_id}</code>
              <span className="font-medium text-[var(--text)]">{activeRow.title}</span>
              <span className="num text-[var(--text)]">
                MCP {formatMs(activeRow.tool_latency_ms)} ({activeRow.tool_passed ? "pass" : "fail"})
              </span>
              <span className="num text-[var(--muted)]">
                Base {formatMs(activeRow.baseline_latency_ms)} (
                {activeRow.baseline_passed ? "pass" : "fail"})
              </span>
              {activeRow.total_tokens > 0 && (
                <span className="num text-[var(--muted)]">
                  {formatInt(activeRow.total_tokens)} tok
                </span>
              )}
            </div>
          ) : (
            <span className="text-[var(--muted)]">No scenario telemetry loaded.</span>
          )}

          <div className="flex flex-wrap items-center gap-3 text-[12px] text-[var(--muted)]">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-[1px]"
                style={{ backgroundColor: "var(--chart-1)" }}
              />
              MCP pass
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-[1px]"
                style={{ backgroundColor: "var(--negative)" }}
              />
              MCP fail
            </span>
            {activeMetric === "latency" && (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-0.5 w-3"
                  style={{ backgroundColor: "var(--text)", opacity: 0.65 }}
                />
                Baseline
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 w-full">
        <svg
          viewBox="0 0 720 250"
          className="h-auto w-full select-none"
          role="img"
          aria-label="Per-scenario evaluation comparison chart"
        >
          {ticks.map((tickValue) => {
            const y = plotBottom - (tickValue / yMax) * plotHeight;
            const isBaseline = tickValue === 0;
            return (
              <g key={tickValue}>
                <line
                  x1={plotLeft}
                  x2={plotRight}
                  y1={y}
                  y2={y}
                  stroke={isBaseline ? "var(--border-strong)" : "var(--grid)"}
                  strokeWidth={isBaseline ? 1.5 : 1}
                />
                <text
                  x={plotLeft - 8}
                  y={y + 4}
                  textAnchor="end"
                  fontSize="11"
                  fill="var(--muted)"
                  className="num"
                >
                  {formatAxisTick(tickValue, activeMetric)}
                </text>
              </g>
            );
          })}

          {gateY !== null && (
            <g>
              <line
                x1={plotLeft}
                x2={plotRight}
                y1={gateY}
                y2={gateY}
                stroke="var(--warning)"
                strokeWidth={1}
                strokeDasharray="4 4"
              />
              <text
                x={plotRight - 2}
                y={Math.max(plotTop + 10, gateY - 5)}
                textAnchor="end"
                fontSize="11"
                fill="var(--warning)"
                className="num"
              >
                Gate {formatMs(latencyGateMs)}
              </text>
            </g>
          )}

          {/* Peak & adversarial 1px annotation leader lines */}
          {peakRow && rows.length <= 32 && (
            <g aria-hidden="true">
              {(() => {
                const cx = plotLeft + slotWidth * (peakIdx + 0.5);
                const val =
                  activeMetric === "latency" ? peakRow.tool_latency_ms : peakRow.total_tokens;
                const barTopY = plotBottom - Math.max(2, (val / yMax) * plotHeight);
                const labelY = 14;
                const anchor = cx > plotRight - 140 ? "end" : "start";
                const textX = anchor === "end" ? cx - 6 : cx + 6;
                return (
                  <g>
                    <line
                      x1={cx}
                      x2={cx}
                      y1={labelY + 4}
                      y2={Math.max(labelY + 4, barTopY - 3)}
                      stroke="var(--border-strong)"
                      strokeWidth={1}
                    />
                    <text
                      x={textX}
                      y={labelY}
                      textAnchor={anchor}
                      fontSize="11"
                      fill="var(--text)"
                      className="num"
                    >
                      Peak {peakRow.scenario_id} (
                      {activeMetric === "latency"
                        ? formatMs(peakRow.tool_latency_ms)
                        : `${formatInt(peakRow.total_tokens)} tok`}
                      )
                    </text>
                  </g>
                );
              })()}
            </g>
          )}

          {advRow && firstAdvIdx >= 0 && rows.length <= 32 && (
            <g aria-hidden="true">
              {(() => {
                const cx = plotLeft + slotWidth * (firstAdvIdx + 0.5);
                const val =
                  activeMetric === "latency" ? advRow.tool_latency_ms : advRow.total_tokens;
                const barTopY = plotBottom - Math.max(2, (val / yMax) * plotHeight);
                const labelY = 26;
                const anchor = cx < plotLeft + 110 ? "start" : "end";
                const textX = anchor === "start" ? cx + 6 : cx - 6;
                return (
                  <g>
                    <line
                      x1={cx}
                      x2={cx}
                      y1={labelY + 4}
                      y2={Math.max(labelY + 4, barTopY - 3)}
                      stroke="var(--border-strong)"
                      strokeWidth={1}
                    />
                    <text
                      x={textX}
                      y={labelY}
                      textAnchor={anchor}
                      fontSize="11"
                      fill="var(--muted)"
                      className="num"
                    >
                      {advRow.scenario_id} probe {advRow.injection_blocked ? "blocked" : "exposed"}
                    </text>
                  </g>
                );
              })()}
            </g>
          )}

          {rows.map((row, idx) => {
            const cx = plotLeft + slotWidth * (idx + 0.5);
            const barX = cx - barWidth / 2;
            const primaryValue =
              activeMetric === "latency" ? row.tool_latency_ms : row.total_tokens;
            const barHeight = Math.max(
              primaryValue > 0 ? 2 : 0,
              (primaryValue / yMax) * plotHeight,
            );
            const barY = plotBottom - barHeight;
            const isSelected = row.scenario_id === activeId;
            const fill = row.tool_passed ? "var(--chart-1)" : "var(--negative)";

            const baseY =
              activeMetric === "latency"
                ? plotBottom - (row.baseline_latency_ms / yMax) * plotHeight
                : null;

            const showXLabel =
              idx === 0 ||
              idx === rows.length - 1 ||
              (idx + 1) % labelStride === 0;
            const barAriaLabel =
              activeMetric === "latency"
                ? `${row.scenario_id} ${row.title}: MCP ${formatMs(row.tool_latency_ms)} (${row.tool_passed ? "pass" : "fail"}), Baseline ${formatMs(row.baseline_latency_ms)}`
                : `${row.scenario_id} ${row.title}: ${formatInt(row.total_tokens)} tokens (${row.tool_passed ? "pass" : "fail"})`;

            return (
              <g
                key={row.scenario_id}
                role="button"
                tabIndex={0}
                aria-label={barAriaLabel}
                aria-pressed={row.scenario_id === selectedScenarioId}
                onMouseEnter={() => setHoveredId(row.scenario_id)}
                onMouseLeave={() => setHoveredId(null)}
                onFocus={() => setHoveredId(row.scenario_id)}
                onBlur={() => setHoveredId(null)}
                onClick={() => onSelectScenario(row.scenario_id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectScenario(row.scenario_id);
                  }
                }}
                className="cursor-pointer focus:outline-none"
              >
                <rect
                  x={plotLeft + slotWidth * idx}
                  y={plotTop}
                  width={slotWidth}
                  height={plotHeight}
                  fill={isSelected ? "var(--accent-soft)" : "transparent"}
                />
                <rect
                  x={barX}
                  y={barY}
                  width={barWidth}
                  height={barHeight}
                  fill={fill}
                  opacity={isSelected ? 1 : 0.85}
                />
                {baseY !== null && (
                  <line
                    x1={barX - baselineTickOverhang}
                    x2={barX + barWidth + baselineTickOverhang}
                    y1={baseY}
                    y2={baseY}
                    stroke="var(--text)"
                    strokeOpacity={0.65}
                    strokeWidth={2}
                  />
                )}
                {showXLabel && (
                  <text
                    x={cx}
                    y={plotBottom + 18}
                    textAnchor="middle"
                    fontSize="11"
                    fill="var(--muted)"
                    className="num"
                  >
                    {row.scenario_id}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
