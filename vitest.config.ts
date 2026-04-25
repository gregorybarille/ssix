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
    },
  }),
);
