import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

// Vite 7 changed the default `build.target` to `'baseline-widely-available'`,
// which silently shifts which JS features are down-leveled. SSX runs inside
// Tauri's WebView (WKWebView on macOS, WebView2 on Windows, WebKitGTK on
// Linux); pinning the target makes browser-feature support deterministic
// and matches Node 22 / Tauri 2's runtime baseline.
const buildTarget = ["es2022", "safari16", "chrome120", "edge120"];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  build: {
    target: buildTarget,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
  },
});
