import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CheckLatencyBudgetSchema,
  InspectLogExcerptSchema,
  LookupRunbookSchema,
} from "./schemas.js";
import { checkLatencyBudget, inspectLogExcerpt, lookupRunbook } from "./tools.js";

const server = new McpServer({
  name: "agentgate-ops-mcp",
  version: "0.1.0",
});

server.tool(
  "inspect_log_excerpt",
  "Read bounded diagnostic log lines for a service (untrusted external telemetry; read-only).",
  InspectLogExcerptSchema,
  async ({ service, maxLines }) => ({
    content: [{ type: "text", text: JSON.stringify(inspectLogExcerpt(service, maxLines)) }],
  }),
);

server.tool(
  "check_latency_budget",
  "Compare observed service p95 latency in milliseconds against its SLA budget.",
  CheckLatencyBudgetSchema,
  async ({ service, p95Ms }) => ({
    content: [{ type: "text", text: JSON.stringify(checkLatencyBudget(service, p95Ms)) }],
  }),
);

server.tool(
  "lookup_runbook",
  "Fetch the verified diagnostic checklist and runbook ID for an incident symptom category.",
  LookupRunbookSchema,
  async ({ symptomTag }) => ({
    content: [{ type: "text", text: JSON.stringify(lookupRunbook(symptomTag)) }],
  }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error("AgentGate MCP server failed to start:", error);
  process.exit(1);
});
