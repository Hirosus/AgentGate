import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = resolve(scriptDir, "..");
const benchmarksDir = resolve(dashboardRoot, "../../benchmarks");
const dataDir = resolve(dashboardRoot, "src/data");

const FILES = ["scenarios.json", "latest-report.json", "gemini-report.json"];

if (!existsSync(benchmarksDir)) {
  // Standalone builds (e.g., Vercel Root Directory = packages/dashboard) use committed src/data/*.json.
  process.exit(0);
}

mkdirSync(dataDir, { recursive: true });

for (const filename of FILES) {
  const src = resolve(benchmarksDir, filename);
  const dest = resolve(dataDir, filename);
  if (existsSync(src)) {
    copyFileSync(src, dest);
  }
}
