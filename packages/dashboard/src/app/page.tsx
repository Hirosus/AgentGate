import { ScoreboardApp } from "@/components/ScoreboardApp";
import geminiReportJson from "@/data/gemini-report.json";
import latestReportJson from "@/data/latest-report.json";
import scenariosJson from "@/data/scenarios.json";
import type {
  EvalScenario,
  EvalSuiteReport,
  RunDataset,
} from "@/lib/evalData";

export default function HomePage() {
  const scenarios = scenariosJson as readonly EvalScenario[];
  const geminiReport = geminiReportJson as EvalSuiteReport;
  const deterministicReport = latestReportJson as EvalSuiteReport;

  const datasets: readonly RunDataset[] = [
    {
      id: "gemini-live",
      label: "Gemini 3.1 Flash Lite",
      subtitle:
        "Live free-tier REST run (shared 3.0s pacing + batched MCP tools) against TypeScript MCP stdio server",
      modelLabel: "gemini-3.1-flash-lite + MCP stdio",
      latencyGateMs: 20000,
      minToolPassRate: 0.85,
      minDelta: 0.0,
      report: geminiReport,
    },
    {
      id: "deterministic-mcp",
      label: "Deterministic MCP CI",
      subtitle: "Offline GitHub Actions PR gate (HeuristicBaselineRunner vs. McpTriageRunner)",
      modelLabel: "McpTriageRunner + MCP stdio",
      latencyGateMs: 4000,
      minToolPassRate: 0.95,
      minDelta: 0.5,
      report: deterministicReport,
    },
  ];

  return <ScoreboardApp datasets={datasets} scenarios={scenarios} />;
}
