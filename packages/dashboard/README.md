# AgentGate Eval Scoreboard UI

Next.js App Router + Tailwind CSS scoreboard visualizing real AgentGate evaluation artifacts (`benchmarks/gemini-report.json`, `benchmarks/latest-report.json`, and `benchmarks/scenarios.json`) plus interactive inspection for uploaded `EvalSuiteReport` JSON files.

## Local Development

```bash
cd packages/dashboard
npm install
npm run dev
```

`npm run dev` and `npm run build` automatically run `scripts/sync-reports.mjs`, syncing report JSON files from `../../benchmarks/` into `src/data/`.

## Checks & Production Build

```bash
npm run typecheck
npm run build
```

## Vercel Deployment

1. Import `Hirosus/AgentGate` in Vercel.
2. Set **Root Directory** to `packages/dashboard`.
3. Keep framework preset **Next.js** (build command `npm run build`, install command `npm install`).
