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
  const safeMax = maxRaw > 0 ? maxRaw * 1.12 : 10;
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
  const plotTop = 22;
  const plotBottom = 216;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;

  const slotWidth = rows.length > 0 ? plotWidth / rows.length : plotWidth;
  const barWidth = Math.max(8, Math.min(22, slotWidth * 0.56));

  const activeId = hoveredId ?? selectedScenarioId ?? rows[0]?.scenario_id ?? null;
  const activeRow = rows.find((row) => row.scenario_id === activeId) ?? rows[0];

  const showGateLine =
    activeMetric === "latency" && latencyGateMs > 0 && latencyGateMs <= yMax;
  const gateY = showGateLine
    ? plotBottom - (latencyGateMs / yMax) * plotHeight
    : null;

  return (
    <section className="flex h-full flex-col justify-between rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-5">
      <div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-[16px] font-semibold text-[var(--text)]">
              {activeMetric === "latency"
                ? "Per-scenario latency (MCP vs. baseline)"
                : "Per-scenario token expenditure"}
            </h2>
            <p className="mt-0.5 text-[13px] text-[var(--muted)]">
              {activeMetric === "latency"
                ? `Bars show MCP tool latency; tick marks show baseline latency. Gate ceiling <= ${formatMs(latencyGateMs)}.`
                : "Total prompt plus completion tokens across MCP tool turns per scenario."}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {totalTokens > 0 && (
              <div
                className="inline-flex rounded-[6px] border border-[var(--border)] bg-[var(--raised)] p-0.5 text-[13px]"
                role="group"
                aria-label="Chart metric"
              >
                <button
                  type="button"
                  onClick={() => setMetric("latency")}
                  className={`rounded-[4px] px-2.5 py-1 font-medium transition-colors ${
                    activeMetric === "latency"
                      ? "bg-[var(--active)] text-[var(--text)]"
                      : "text-[var(--muted)] hover:text-[var(--text)]"
                  }`}
                >
                  Latency
                </button>
                <button
                  type="button"
                  onClick={() => setMetric("tokens")}
                  className={`rounded-[4px] px-2.5 py-1 font-medium transition-colors ${
                    activeMetric === "tokens"
                      ? "bg-[var(--active)] text-[var(--text)]"
                      : "text-[var(--muted)] hover:text-[var(--text)]"
                  }`}
                >
                  Tokens
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[6px] border border-[var(--rule)] bg-[var(--raised)] px-3 py-2 text-[13px]">
          {activeRow ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <code className="font-medium text-[var(--accent)]">{activeRow.scenario_id}</code>
              <span className="text-[var(--text)]">{activeRow.title}</span>
              <span className="num text-[var(--text)]">
                MCP {formatMs(activeRow.tool_latency_ms)} ({activeRow.tool_passed ? "pass" : "fail"})
              </span>
              <span className="num text-[var(--muted)]">
                Baseline {formatMs(activeRow.baseline_latency_ms)} (
                {activeRow.baseline_passed ? "pass" : "fail"})
              </span>
              {activeRow.total_tokens > 0 && (
                <span className="num text-[var(--muted)]">
                  {formatInt(activeRow.total_tokens)} tok
                </span>
              )}
            </div>
          ) : (
            <span className="text-[var(--muted)]">No scenario telemetry available.</span>
          )}

          <div className="flex flex-wrap items-center gap-4 text-[12px] text-[var(--muted)]">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-2.5 rounded-[2px]"
                style={{ backgroundColor: "var(--chart-1)" }}
              />
              MCP pass
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-2.5 rounded-[2px]"
                style={{ backgroundColor: "var(--negative)" }}
              />
              MCP fail
            </span>
            {activeMetric === "latency" && (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-0.5 w-3"
                  style={{ backgroundColor: "var(--chart-2)" }}
                />
                Baseline
              </span>
            )}
            {showGateLine && (
              <span className="inline-flex items-center gap-1.5 text-[var(--warning)]">
                <span className="inline-block w-3 border-t border-dashed border-[var(--warning)]" />
                Gate {formatMs(latencyGateMs)}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 w-full">
        <svg
          viewBox="0 0 720 246"
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
                  stroke={isBaseline ? "var(--border-strong)" : "var(--rule)"}
                  strokeWidth={1}
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
            <line
              x1={plotLeft}
              x2={plotRight}
              y1={gateY}
              y2={gateY}
              stroke="var(--warning)"
              strokeWidth={1.25}
              strokeDasharray="4 4"
            />
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
              (idx + 1) % 5 === 0;

            return (
              <g
                key={row.scenario_id}
                onMouseEnter={() => setHoveredId(row.scenario_id)}
                onMouseLeave={() => setHoveredId(null)}
                onClick={() => onSelectScenario(row.scenario_id)}
                className="cursor-pointer"
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
                  rx={2}
                  ry={2}
                  fill={fill}
                  opacity={isSelected ? 1 : 0.85}
                />
                {baseY !== null && (
                  <line
                    x1={barX - 2}
                    x2={barX + barWidth + 2}
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
