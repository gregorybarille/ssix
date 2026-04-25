/**
 * WebdriverIO config for SSX E2E tests.
 *
 * Drives the real Tauri application binary via `tauri-driver`, which
 * proxies WebDriver commands to the platform's native WebView driver
 * (WebKitWebDriver on Linux, MSEdgeDriver on Windows). macOS is NOT
 * supported by tauri-driver — run via the dockerized E2E runner
 * (`npm run e2e`) or in CI.
 *
 * The Tauri binary path is resolved at runtime by `helpers/app.ts`
 * so the same config works for `--debug` (CI default) and `--release`
 * builds without edits.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Options } from "@wdio/types";
import { resolveBinaryPath } from "./helpers/app.js";
import { setupTestDataDir, cleanupTestDataDir } from "./helpers/data-dir.js";

const ROOT = resolve(__dirname, "..");
const ARTIFACTS = join(__dirname, ".artifacts");
mkdirSync(ARTIFACTS, { recursive: true });

let tauriDriver: ChildProcess | null = null;

export const config: Options.Testrunner = {
  runner: "local",
  tsConfigPath: "./tsconfig.json",

  specs: ["./specs/**/*.spec.ts"],
  exclude: [],

  maxInstances: 1, // Tauri E2E is inherently serial — one app window at a time.
  capabilities: [
    {
      // tauri-driver exposes a dummy "browserName: tauri" capability and
      // routes commands to the bundled WebView driver. The actual binary
      // path is set per-spec via app.launch() so we can rotate
      // SSX_DATA_DIR between runs.
      browserName: "wry",
      "tauri:options": {
        application: resolveBinaryPath(),
      },
    } as WebdriverIO.Capabilities,
  ],

  logLevel: "info",
  bail: 0,
  baseUrl: "http://localhost",
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,

  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 120_000,
  },

  // tauri-driver listens on :4444 by default. We spawn it once per
  // wdio session and clean up afterwards. The shared SSX_DATA_DIR
  // is created BEFORE tauri-driver spawns so the env var is
  // inherited by the SSX app subprocess.
  onPrepare() {
    setupTestDataDir();
    if (!existsSync(join(ROOT, "src-tauri", "target"))) {
      throw new Error(
        "src-tauri/target not found. Build the app first: `npm run tauri build -- --debug`",
      );
    }
    tauriDriver = spawn("tauri-driver", [], {
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    });
    tauriDriver.on("error", (err) => {
      console.error("[tauri-driver] failed to start:", err);
      console.error("Install with: cargo install tauri-driver --locked");
    });
  },

  onComplete() {
    if (tauriDriver && !tauriDriver.killed) {
      tauriDriver.kill();
    }
    cleanupTestDataDir();
  },

  // Capture screenshot on every failed mocha test for easy triage from
  // CI artifacts.
  afterTest: async function (test, _ctx, { error }) {
    if (error) {
      const safe = `${test.parent}-${test.title}`.replace(/[^a-z0-9-_]/gi, "_");
      try {
        await browser.saveScreenshot(join(ARTIFACTS, `${safe}.png`));
      } catch {
        // best effort
      }
    }
  },
};
