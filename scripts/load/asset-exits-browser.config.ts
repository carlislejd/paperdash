import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
export default defineConfig({
  testDir: ".", testMatch: "asset-exits-browser.pw.ts", timeout: 100_000, workers: 1,
  outputDir: "../../.private/asset-exit-browser-load/results",
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4188", reducedMotion: "no-preference" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "pixel-emulation-4x-cpu", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    command: "npx vite build --outDir ../../.private/asset-exits-browser-build --emptyOutDir && npx vite preview --host 127.0.0.1 --port 4188 --strictPort --outDir ../../.private/asset-exits-browser-build",
    url: "http://127.0.0.1:4188", timeout: 30_000,
  },
});
