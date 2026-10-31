import { describe, it, expect } from "vitest";
import type { Connection, ScriptResult } from "@/types";
import { describeScriptEnd, formatDuration, planScriptRun, scriptStatus } from "@/lib/scripts";

const result = (overrides: Partial<ScriptResult> = {}): ScriptResult => ({
  stdout: "",
  stderr: "",
  exit_code: 0,
  exit_signal: null,
  duration_ms: 5,
  truncated: false,
  timed_out: false,
  cancelled: false,
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

  it("describes each way a script ends", () => {
    expect(describeScriptEnd(result({ exit_code: 3 }))).toBe("exit 3");
    expect(describeScriptEnd(result({ exit_code: null, exit_signal: "TERM" }))).toBe("killed by SIGTERM");
    expect(describeScriptEnd(result({ exit_code: null, timed_out: true }))).toBe("stopped at the time limit");
    expect(describeScriptEnd(result({ exit_code: null }))).toBe("no exit status");
    expect(describeScriptEnd(result({ exit_code: null, exit_signal: "TERM", cancelled: true }))).toBe("cancelled");
  });

  it("formats durations", () => {
    expect(formatDuration(250)).toBe("250 ms");
    expect(formatDuration(2500)).toBe("2.5 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
  });

  it("plans the picked hosts in list order", () => {
    const steps = planScriptRun([conn("a"), conn("b"), conn("c")], new Set(["c", "a"]));
    expect(steps.map((s) => s.connectionId)).toEqual(["a", "c"]);
    expect(steps.every((s) => s.status === "pending")).toBe(true);
  });
});
