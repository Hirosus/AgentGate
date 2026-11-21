# AgentGate Incident Triage & Eval Operations Console

Next.js 15 App Router + React 19 + Tailwind CSS v4 operations console combining an interactive live `v2=` signed webhook triage workbench, real-time MCP diagnostic inspection, runbook coverage & prompt-injection auditing, and benchmark scoreboard analysis.

## Features

- **Live Triage Workbench (`POST /api/triage`, `POST /api/triage/reset`):**
  - Dispatches `v2=` HMAC-SHA256 signed incident payloads (`{timestamp}.{idempotencyKey}.{rawBody}`) with selectable fault simulations (`valid`, `duplicate_replay`, `tamper_body`, `stale_timestamp`) and prompt-injection override toggles.
  - Supports **Instant MCP** (`deterministic_mcp`) and **Live AI** (`live_ai` via Gemini function calling with a 5 req/min/IP rate guard and automatic deterministic MCP fallback when `GEMINI_API_KEY` is unset, rate-limited, or timed out).
  - Visualizes the **5-stage execution pipeline trace** (`Replay Window`, `HMAC-SHA256 v2 Signature`, `Idempotency Ledger`, `MCP Diagnostic Tools`, `Structured Verdict & Injection Guard`), expandable MCP tool traces, side-by-side No-Tool Baseline vs. MCP-Assisted comparison, and a side-by-side **HTTP wire diff** (`rawBody` vs. `wireBody`).
  - Uses a signed `HttpOnly` cookie session ledger (`agentgate_demo_keys`) with same-origin enforcement and one-click reset (`Clear demo keys` via `POST /api/triage/reset`).
- **Eval Benchmarks & JSON Upload:**
  - Compares pre-synced [`src/data/gemini-report.json`](src/data/gemini-report.json), [`src/data/latest-report.json`](src/data/latest-report.json), and [`src/data/scenarios.json`](src/data/scenarios.json), plus client-side `EvalSuiteReport` JSON import (up to 2 MB), paired latency/token charts, CI quality gate breakdown, and per-scenario diagnostics (`ScenarioDetailPanel`).
- **Navigation, Runbooks & Themes:**
  - Interactive **Runbook Drawer** (`RunbookDrawer`) backed by synced [`src/data/mcp-catalog.json`](src/data/mcp-catalog.json), global **Command Palette** (`Ctrl+K` / `⌘K`), and persisted Dark/Light themes (`localStorage` `agentgate-theme`, dark-first default).

## Scripts & Local Development

```bash
cd packages/dashboard
npm install
npm run dev
```

Available scripts in [`package.json`](package.json):
- `npm run dev` — runs `predev` (`node scripts/sync-reports.mjs`) and starts `next dev`
- `npm test` — compiles TypeScript test target (`tsconfig.test.json`) and executes `node --test` on `triageEngine.test.ts` and `evalData.test.ts`
- `npm run typecheck` — runs `node scripts/sync-reports.mjs`, `next typegen`, and `tsc --noEmit`
- `npm run build` — runs `prebuild` (`node scripts/sync-reports.mjs`) and builds production Next.js bundle
- `node scripts/sync-reports.mjs` (or `npm run sync-data`) — syncs `../../benchmarks/{scenarios,latest-report,gemini-report}.json` and `../../packages/mcp-server/src/catalog.json` into `src/data/`

## Vercel Deployment & Environment Variables

1. Import `Hirosus/AgentGate` in Vercel and set **Root Directory** to `packages/dashboard`.
2. Keep the **Next.js** framework preset (`npm install`, `npm run build`). Pre-synced files in `src/data/*.json` allow standalone Vercel builds without parent monorepo paths.
3. Configure environment variables in Vercel Project Settings (or local `.env.local`):
   - `GEMINI_API_KEY`: enables Live AI Gemini MCP function calling on `/api/triage` (optional; falls back cleanly to deterministic MCP when unset)
   - `AGENTGATE_DEMO_WEBHOOK_SECRET` *(or `AGENTGATE_WEBHOOK_SECRET`)*: HMAC secret used to sign demo webhooks and the `agentgate_demo_keys` session ledger cookie (strongly recommended in production)
   - `GEMINI_MODEL` *(optional)*: overrides Gemini model (defaults to `gemini-3.1-flash-lite`)
   - `AGENTGATE_WEBHOOK_MAX_AGE_SECONDS` *(optional)*: bounded replay window in seconds (defaults to `300`, valid range `1..86400`)
