import { ScoreboardApp } from "@/components/ScoreboardApp";
import geminiReportJson from "@/data/gemini-report.json";
import latestReportJson from "@/data/latest-report.json";
import scenariosJson from "@/data/scenarios.json";
import type {
  EvalScenario,
  EvalSuiteReport,
  McpCatalog,
  RunDataset,
} from "@/lib/evalData";
import { MCP_CATALOG } from "@/lib/triageCatalog";

export default function HomePage() {
  const scenarios = scenariosJson as readonly EvalScenario[];
  const geminiReport = geminiReportJson as EvalSuiteReport;
  const deterministicReport = latestReportJson as EvalSuiteReport;
  const catalog = MCP_CATALOG as McpCatalog;

  const datasets: readonly RunDataset[] = [
    {
      id: "gemini-live",
      label: "Live LLM Suite",
      subtitle: `${geminiReport.total_cases}-scenario live evaluation with shared rate pacing and batched MCP tool execution`,
      modelLabel: "gemini-3.1-flash-lite + MCP stdio",
      latencyGateMs: 20000,
      minToolPassRate: 0.85,
      minDelta: 0.0,
      report: geminiReport,
    },
    {
      id: "deterministic-mcp",
      label: "CI Regression Suite",
      subtitle: `${deterministicReport.total_cases}-scenario pull-request quality gate comparing no-tool heuristics against MCP triage`,
      modelLabel: "Deterministic MCP stdio",
      latencyGateMs: 4000,
      minToolPassRate: 0.95,
      minDelta: 0.5,
      report: deterministicReport,
    },
  ];

  return <ScoreboardApp datasets={datasets} scenarios={scenarios} catalog={catalog} />;
}
