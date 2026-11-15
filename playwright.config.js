import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
const dataDir = mkdtempSync("/tmp/studylight-browser-");
export default defineConfig({
  testDir: "./test/browser",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://127.0.0.1:3100",
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: [
        "--no-sandbox",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    },
    permissions: ["camera", "microphone"],
  },
  webServer: {
    command: `PORT=3100 DATA_DIR=${dataDir} node server.js`,
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
  },
});
