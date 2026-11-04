import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const { csp, devCsp } = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).app.security;

function directive(policy: string, name: string): string[] {
  const found = policy.split(";").map((d) => d.trim().split(/\s+/)).find(([n]) => n === name);
  return found ? found.slice(1) : [];
}

describe("tauri.conf.json CSP", () => {
  // Without these the first IPC fetch is blocked and the webview falls back to
  // postMessage for good, which turns terminal output into evaluated JSON arrays.
  it.each([["csp", csp], ["devCsp", devCsp]])("%s allows Tauri's IPC protocol", (_name, policy) => {
    expect(directive(policy, "connect-src")).toEqual(
      expect.arrayContaining(["ipc:", "http://ipc.localhost"]),
    );
  });

  it("names the dev server only in devCsp", () => {
    expect(csp).not.toContain("localhost:1420");
    expect(directive(devCsp, "script-src")).toContain("http://localhost:1420");
  });
});
