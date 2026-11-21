import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import catalog from "./catalog.json" with { type: "json" };
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
  catalog.toolDescriptions.inspect_log_excerpt,
  InspectLogExcerptSchema,
  async ({ service, maxLines }) => ({
    content: [{ type: "text", text: JSON.stringify(inspectLogExcerpt(service, maxLines)) }],
  }),
);

server.tool(
  "check_latency_budget",
  catalog.toolDescriptions.check_latency_budget,
  CheckLatencyBudgetSchema,
  async ({ service, p95Ms }) => ({
    content: [{ type: "text", text: JSON.stringify(checkLatencyBudget(service, p95Ms)) }],
  }),
);

server.tool(
  "lookup_runbook",
  catalog.toolDescriptions.lookup_runbook,
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
