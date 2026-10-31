import { describe, it, expect } from "vitest";
import type { Connection, ScriptResult } from "@/types";
import {
  formatDuration,
  interpreterForPlatform,
  planScriptRun,
  scriptStatus,
} from "@/lib/scripts";

const result = (overrides: Partial<ScriptResult> = {}): ScriptResult => ({
  stdout: "",
  stderr: "",
  exit_code: 0,
  exit_signal: null,
  duration_ms: 5,
  truncated: false,
  timed_out: false,
  cancelled: false,
  end: "exit 0",
  ...overrides,
});

const conn = (id: string): Connection => ({ id, name: `host-${id}`, host: "h", port: 22, type: "direct" });

describe("scripts helpers", () => {
  it("counts only exit 0 as success", () => {
    expect(scriptStatus(result())).toBe("success");
    expect(scriptStatus(result({ exit_code: 2 }))).toBe("error");
    expect(scriptStatus(result({ exit_code: null, exit_signal: "KILL" }))).toBe("error");
    expect(scriptStatus(result({ exit_code: null, exit_signal: "TERM", cancelled: true }))).toBe("cancelled");
  });

  it("formats durations", () => {
    expect(formatDuration(250)).toBe("250 ms");
    expect(formatDuration(2500)).toBe("2.5 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
  });

  it("swaps the interpreter to the new platform's default unless it was typed", () => {
    expect(interpreterForPlatform("windows", "sh -s")).toBe("powershell");
    expect(interpreterForPlatform("windows", "python3 -")).toBe("powershell");
    expect(interpreterForPlatform("windows", "  ")).toBe("powershell");
    expect(interpreterForPlatform("posix", "pwsh")).toBe("sh -s");
    expect(interpreterForPlatform("windows", "pwsh")).toBe("pwsh");
    expect(interpreterForPlatform("windows", "sudo sh -s")).toBe("sudo sh -s");
  });

  it("plans the picked hosts in list order", () => {
    const steps = planScriptRun([conn("a"), conn("b"), conn("c")], new Set(["c", "a"]));
    expect(steps.map((s) => s.connectionId)).toEqual(["a", "c"]);
    expect(steps.every((s) => s.status === "pending")).toBe(true);
  });
});
