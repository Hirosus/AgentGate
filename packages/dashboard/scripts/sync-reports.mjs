import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = resolve(scriptDir, "..");
const benchmarksDir = resolve(dashboardRoot, "../../benchmarks");
const mcpCatalogSrc = resolve(dashboardRoot, "../../packages/mcp-server/src/catalog.json");
const dataDir = resolve(dashboardRoot, "src/data");

const BENCHMARK_FILES = ["scenarios.json", "latest-report.json", "gemini-report.json"];

let ensuredDataDir = false;
function ensureDataDir() {
  if (!ensuredDataDir) {
    mkdirSync(dataDir, { recursive: true });
    ensuredDataDir = true;
  }
}

if (existsSync(benchmarksDir)) {
  for (const filename of BENCHMARK_FILES) {
    const src = resolve(benchmarksDir, filename);
    const dest = resolve(dataDir, filename);
    if (existsSync(src)) {
      ensureDataDir();
      copyFileSync(src, dest);
    }
  }
}

if (existsSync(mcpCatalogSrc)) {
  ensureDataDir();
  copyFileSync(mcpCatalogSrc, resolve(dataDir, "mcp-catalog.json"));
}

// Standalone builds (e.g., Vercel Root Directory = packages/dashboard) use committed src/data/*.json.
process.exit(0);
