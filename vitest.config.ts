import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Test config is kept separate from `vite.config.ts` so the dev/build
// pipeline doesn't pull in vitest's types and `defineConfig` overload.
// `mergeConfig` keeps the resolve aliases (`@/*`) and React plugin in
// sync with the dev/build config.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
      // E2E specs run under WebdriverIO + Mocha (see e2e/wdio.conf.ts),
      // not vitest. Excluding them prevents `ReferenceError: before is
      // not defined` when running `npm test`.
      exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
    },
  }),
);
