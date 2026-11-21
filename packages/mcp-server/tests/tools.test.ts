import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  CheckLatencyBudgetSchema,
  InspectLogExcerptSchema,
  LookupRunbookSchema,
} from "../src/schemas.js";
import {
  checkLatencyBudget,
  inspectLogExcerpt,
  lookupRunbook,
} from "../src/tools.js";

interface JsonRpcResponse {
  readonly jsonrpc: string;
  readonly id?: number;
  readonly result?: {
    readonly tools?: readonly {
      readonly name: string;
      readonly inputSchema?: {
        readonly properties?: Readonly<Record<string, { readonly description?: string }>>;
      };
    }[];
    readonly content?: readonly { readonly type: string; readonly text?: string }[];
    readonly isError?: boolean;
  };
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
}

describe("inspectLogExcerpt", () => {
  it("returns bounded lines, sets truncated flag, and marks untrustedTelemetry", () => {
    const res = inspectLogExcerpt("checkout-api", 1);
    assert.equal(res.service, "checkout-api");
    assert.equal(res.lines.length, 1);
    assert.equal(res.truncated, true);
    assert.equal(res.untrustedTelemetry, true);
  });

  it("sanitizes embedded control characters and truncates oversized log lines", () => {
    const longLine = "A".repeat(260);
    const res = inspectLogExcerpt("custom-svc", 5, {
      "custom-svc": [
        "2026-11-19T12:00:00Z\r\nWARN\x00\x1b[31m injected-control",
        longLine,
      ],
    });
    assert.equal(res.untrustedTelemetry, true);
    assert.equal(res.lines.length, 2);
    const first = res.lines[0];
    const second = res.lines[1];
    assert.ok(first !== undefined);
    assert.ok(second !== undefined);
    assert.equal(/[\x00-\x1f\x7f]/.test(first), false);
    assert.match(first, /WARN/);
    assert.equal(second.length, 240);
    assert.ok(second.endsWith("..."));
  });

  it("returns empty lines for unknown services", () => {
    const res = inspectLogExcerpt("unknown-service", 10);
    assert.equal(res.lines.length, 0);
    assert.equal(res.truncated, false);
    assert.equal(res.untrustedTelemetry, true);
  });

  it("ignores Object.prototype keys like constructor and __proto__", () => {
    const ctorLogs = inspectLogExcerpt("constructor", 10);
    assert.equal(ctorLogs.service, "constructor");
    assert.deepEqual(ctorLogs.lines, []);
    assert.equal(ctorLogs.truncated, false);
    assert.equal(ctorLogs.untrustedTelemetry, true);

    const protoLogs = inspectLogExcerpt("__proto__", 10);
    assert.deepEqual(protoLogs.lines, []);
    assert.equal(protoLogs.truncated, false);
  });
});

describe("checkLatencyBudget", () => {
  it("classifies all four severity bands and falls back to 500ms budget", () => {
    const low = checkLatencyBudget("checkout-api", 200);
    assert.equal(low.breached, false);
    assert.equal(low.recommendedSeverity, "low");

    const medium = checkLatencyBudget("checkout-api", 400);
    assert.equal(medium.breached, true);
    assert.equal(medium.recommendedSeverity, "medium");

    const high = checkLatencyBudget("checkout-api", 820);
    assert.equal(high.breached, true);
    assert.equal(high.recommendedSeverity, "high");

    const critical = checkLatencyBudget("checkout-api", 1300);
    assert.equal(critical.breached, true);
    assert.equal(critical.recommendedSeverity, "critical");

    const fallback = checkLatencyBudget("unlisted-service", 600);
    assert.equal(fallback.budgetMs, 500);
    assert.equal(fallback.breached, true);
    assert.equal(fallback.recommendedSeverity, "medium");
  });

  it("uses 500ms default budget for prototype property names without crashing", () => {
    const ctorBudget = checkLatencyBudget("constructor", 400);
    assert.equal(ctorBudget.budgetMs, 500);
    assert.equal(ctorBudget.breached, false);
    assert.equal(ctorBudget.recommendedSeverity, "low");

    const protoBudget = checkLatencyBudget("__proto__", 1500);
    assert.equal(protoBudget.budgetMs, 500);
    assert.equal(protoBudget.breached, true);
    assert.equal(protoBudget.recommendedSeverity, "high");
  });
});

describe("lookupRunbook", () => {
  it("resolves all 8 verified runbook symptom tags", () => {
    const expected: ReadonlyArray<readonly [Parameters<typeof lookupRunbook>[0], string]> = [
      ["db_pool_exhaustion", "rb-latency-pool"],
      ["webhook_timeout", "rb-webhook-retry"],
      ["auth_failure", "rb-hmac-rotation"],
      ["vlan_packet_loss", "rb-net-vlan"],
      ["tls_cert_expiry", "rb-tls-renewal"],
      ["redis_eviction_spike", "rb-cache-eviction"],
      ["dns_resolution_failure", "rb-dns-resolver"],
      ["lambda_oom_throttle", "rb-lambda-limits"],
    ];

    for (const [tag, expectedId] of expected) {
      const entry = lookupRunbook(tag);
      assert.equal(entry.runbookId, expectedId);
      assert.ok(entry.checks.length >= 2);
    }

    assert.throws(
      () => lookupRunbook("constructor" as unknown as Parameters<typeof lookupRunbook>[0]),
      /Unknown runbook symptom tag/,
    );
  });
});

describe("Zod input validation boundaries", () => {
  it("rejects hostile service identifiers, invalid numeric bounds, and unknown runbook tags", () => {
    const logSchema = z.object(InspectLogExcerptSchema);
    const budgetSchema = z.object(CheckLatencyBudgetSchema);
    const runbookSchema = z.object(LookupRunbookSchema);

    for (const badService of [
      "../etc/passwd",
      "checkout; rm -rf /",
      "UPPER",
      "",
      "a".repeat(65),
    ]) {
      assert.throws(() => logSchema.parse({ service: badService, maxLines: 5 }));
      assert.throws(() => budgetSchema.parse({ service: badService, p95Ms: 100 }));
    }

    assert.throws(() => logSchema.parse({ service: "checkout-api", maxLines: 0 }));
    assert.throws(() => logSchema.parse({ service: "checkout-api", maxLines: 51 }));
    assert.throws(() => budgetSchema.parse({ service: "checkout-api", p95Ms: -1 }));
    assert.throws(() => budgetSchema.parse({ service: "checkout-api", p95Ms: 120_001 }));
    assert.throws(() => runbookSchema.parse({ symptomTag: "override-now" }));
  });
});

describe("MCP stdio server integration", () => {
  it("handles initialize, tools/list, tools/call, and rejects hostile arguments", async () => {
    const serverPath = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
    const child = spawn(process.execPath, [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    const pending = new Map<number, (msg: JsonRpcResponse) => void>();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line.trim().length > 0) {
          const parsed = JSON.parse(line) as JsonRpcResponse;
          if (parsed.id !== undefined) {
            const resolver = pending.get(parsed.id);
            if (resolver) {
              pending.delete(parsed.id);
              resolver(parsed);
            }
          }
        }
        idx = buffer.indexOf("\n");
      }
    });

    const request = (id: number, method: string, params: Record<string, unknown>) =>
      new Promise<JsonRpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for response to ${method}`));
        }, 5000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });

    try {
      const initRes = await request(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agentgate-ts-test", version: "0.1.0" },
      });
      assert.equal(initRes.error, undefined);

      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );

      const listRes = await request(2, "tools/list", {});
      const toolsList = listRes.result?.tools ?? [];
      const toolNames = toolsList.map((tool) => tool.name).sort();
      assert.deepEqual(toolNames, [
        "check_latency_budget",
        "inspect_log_excerpt",
        "lookup_runbook",
      ]);

      const lookupTool = toolsList.find((tool) => tool.name === "lookup_runbook");
      const symptomDescription = lookupTool?.inputSchema?.properties?.symptomTag?.description ?? "";
      assert.match(symptomDescription, /auth_failure/);
      assert.match(symptomDescription, /webhook_timeout/);

      const logRes = await request(3, "tools/call", {
        name: "inspect_log_excerpt",
        arguments: { service: "checkout-api", maxLines: 5 },
      });
      assert.notEqual(logRes.result?.isError, true);
      const logPayload = JSON.parse(logRes.result?.content?.[0]?.text ?? "{}") as {
        untrustedTelemetry: boolean;
        lines: string[];
      };
      assert.equal(logPayload.untrustedTelemetry, true);
      assert.ok(logPayload.lines.length >= 2);

      const budgetRes = await request(4, "tools/call", {
        name: "check_latency_budget",
        arguments: { service: "checkout-api", p95Ms: 820 },
      });
      const budgetPayload = JSON.parse(budgetRes.result?.content?.[0]?.text ?? "{}") as {
        recommendedSeverity: string;
      };
      assert.equal(budgetPayload.recommendedSeverity, "high");

      const runbookRes = await request(5, "tools/call", {
        name: "lookup_runbook",
        arguments: { symptomTag: "tls_cert_expiry" },
      });
      const runbookPayload = JSON.parse(runbookRes.result?.content?.[0]?.text ?? "{}") as {
        runbookId: string;
      };
      assert.equal(runbookPayload.runbookId, "rb-tls-renewal");

      const hostileRes = await request(6, "tools/call", {
        name: "inspect_log_excerpt",
        arguments: { service: "../etc/passwd", maxLines: 5 },
      });
      assert.ok(hostileRes.error !== undefined || hostileRes.result?.isError === true);
    } finally {
      child.stdin.end();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.killed) {
          resolve();
          return;
        }
        const killTimer = setTimeout(() => {
          child.kill();
          resolve();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    }
  });
});
