import type { Connection, ScriptResult } from "@/types";
import type { StepStatus } from "./bulk-actions";

/** Interpreters offered in the script editor; any remote command works. */
export const INTERPRETER_PRESETS = ["sh -s", "bash -s", "python3 -"] as const;

export const DEFAULT_INTERPRETER = INTERPRETER_PRESETS[0];

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

/** How the script ended, for the result header and the log. */
export function describeScriptEnd(result: ScriptResult): string {
  if (result.cancelled) return "cancelled";
  if (result.timed_out) return "stopped at the time limit";
  if (result.exit_signal) return `killed by SIG${result.exit_signal}`;
  if (result.exit_code == null) return "no exit status";
  return `exit ${result.exit_code}`;
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
