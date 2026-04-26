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
import { mkdirSync, existsSync, openSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Options } from "@wdio/types";
import { resolveBinaryPath } from "./helpers/app.js";
import { setupTestDataDir, cleanupTestDataDir } from "./helpers/data-dir.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ARTIFACTS = join(__dirname, ".artifacts");
mkdirSync(ARTIFACTS, { recursive: true });

let tauriDriver: ChildProcess | null = null;
let driverExit = false;

export const config: Options.Testrunner = {
  runner: "local",
  tsConfigPath: resolve(__dirname, "tsconfig.json"),

  // tauri-driver listens on 127.0.0.1:4444 — point WDIO at it directly
  // instead of letting WDIO auto-detect a browser driver.
  hostname: "127.0.0.1",
  port: 4444,

  specs: ["./specs/**/*.spec.ts"],
  exclude: [],

  maxInstances: 1, // Tauri E2E is inherently serial — one app window at a time.
  capabilities: [
    {
      // No browserName — tauri-driver is not a standard browser driver.
      // The application path is passed via the tauri:options extension
      // capability; tauri-driver forwards it to WebKitWebDriver on Linux.
      maxInstances: 1,
      "tauri:options": {
        application: resolveBinaryPath(),
      },
    } as WebdriverIO.Capabilities,
  ],

  logLevel: "info",
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,

  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 120_000,
  },

  // Create SSX_DATA_DIR before anything else so tauri-driver (and the
  // app it spawns) inherit the env var from this process.
  onPrepare() {
    setupTestDataDir();
    if (!existsSync(join(ROOT, "src-tauri", "target"))) {
      throw new Error(
        "src-tauri/target not found. Build the app first: `npm run tauri build -- --debug`",
      );
    }
  },

  // Spawn tauri-driver just before the WebDriver session opens so the
  // SSX app subprocess inherits the already-set SSX_DATA_DIR.
  // Stdout/stderr are tee'd to e2e/.artifacts/tauri-driver.log so CI
  // failure artifacts capture the SSX backend's eprintln/log output —
  // critical for diagnosing silent SSH failures where the WebDriver
  // log shows the frontend healthy but the backend failed quietly.
  beforeSession() {
    const logPath = join(ARTIFACTS, "tauri-driver.log");
    const logFd = openSync(logPath, "a");
    tauriDriver = spawn("tauri-driver", [], {
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, RUST_BACKTRACE: "1", RUST_LOG: process.env.RUST_LOG ?? "info" },
    });
    tauriDriver.on("error", (err) => {
      console.error("[tauri-driver] failed to start:", err);
      console.error("Install with: cargo install tauri-driver --locked");
    });
    tauriDriver.on("exit", (code) => {
      if (!driverExit) {
        console.error(`[tauri-driver] exited unexpectedly with code ${String(code)}`);
      }
    });
  },

  afterSession() {
    driverExit = true;
    if (tauriDriver && !tauriDriver.killed) {
      tauriDriver.kill();
    }
  },

  onComplete() {
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
