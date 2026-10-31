import type { Connection, ScriptPlatform, ScriptResult } from "@/types";
import type { StepStatus } from "./bulk-actions";

/**
 * Interpreters offered in the script editor, default first. On POSIX any
 * remote command works; on Windows any PowerShell named without spaces.
 */
export const INTERPRETER_PRESETS: Record<ScriptPlatform, readonly string[]> = {
  posix: ["sh -s", "bash -s", "python3 -"],
  windows: ["powershell", "pwsh"],
};

export function defaultInterpreter(platform: ScriptPlatform): string {
  return INTERPRETER_PRESETS[platform][0];
}

export const PLATFORM_LABELS: Record<ScriptPlatform, string> = {
  posix: "Linux, macOS, BSD",
  windows: "Windows",
};

/**
 * The interpreter to show after switching to `platform`: a blank field or
 * one of the other platform's presets becomes the new default, anything the
 * user typed stays.
 */
export function interpreterForPlatform(platform: ScriptPlatform, current: string): string {
  const other: ScriptPlatform = platform === "posix" ? "windows" : "posix";
  const value = current.trim();
  return !value || INTERPRETER_PRESETS[other].includes(value) ? defaultInterpreter(platform) : current;
}

/** One host of a script run. */
export interface ScriptRunStep {
  connectionId: string;
  connectionName: string;
  status: StepStatus;
  result?: ScriptResult;
  /** Why the script could not run at all (connect or auth failure). */
  error?: string;
}

/** A run that exited 0 succeeded; a cancelled one is neither; anything else failed. */
export function scriptStatus(result: ScriptResult): StepStatus {
  if (result.cancelled) return "cancelled";
  return result.exit_code === 0 ? "success" : "error";
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

/** The selected connections in list order, as pending steps. */
export function planScriptRun(connections: Connection[], selected: ReadonlySet<string>): ScriptRunStep[] {
  return connections
    .filter((c) => selected.has(c.id))
    .map((c) => ({ connectionId: c.id, connectionName: c.name, status: "pending" }));
}
