import { create } from "zustand";
import type { Script, ScriptInput, ScriptResult } from "@/types";
import { invoke } from "@/lib/tauri";
import { runAsync, runAsyncRethrow } from "@/lib/asyncAction";
import { errorMessage } from "@/lib/errors";
import { scriptStatus, type ScriptRunStep } from "@/lib/scripts";

interface ScriptRun {
  scriptId: string;
  /** The backend's number for this run, which `cancel_script_run` takes. */
  runNumber: number | null;
  steps: ScriptRunStep[];
}

interface ScriptsState {
  scripts: Script[];
  isLoading: boolean;
  /** Why the last `fetchScripts` failed. Mutations report to their caller. */
  error: string | null;
  /** The latest run, kept while the user is on another view. */
  run: ScriptRun | null;
  running: boolean;
  /** Cancel was asked for and hosts are still stopping. */
  cancelling: boolean;
  fetchScripts: () => Promise<void>;
  addScript: (input: ScriptInput) => Promise<Script>;
  updateScript: (id: string, input: ScriptInput) => Promise<Script>;
  deleteScript: (id: string) => Promise<void>;
  /** Run the script on every step's host at once; resolves when all finish. */
  runScript: (scriptId: string, steps: ScriptRunStep[]) => Promise<void>;
  /**
   * Stop every host of the current run that is still going: each gets
   * SIGTERM and comes back as cancelled. Hosts already done keep their result.
   */
  cancelRun: () => Promise<void>;
}

export const useScriptsStore = create<ScriptsState>((set, get) => ({
  scripts: [],
  isLoading: false,
  error: null,
  run: null,
  running: false,
  cancelling: false,

  fetchScripts: () =>
    runAsync(set, async () => {
      const scripts = await invoke<Script[]>("get_scripts");
      set({ scripts });
    }).then(() => undefined),

  addScript: (input) =>
    runAsyncRethrow(set, async () => {
      const script = await invoke<Script>("add_script", { input });
      set((state) => ({ scripts: [...state.scripts, script] }));
      return script;
    }, { recordError: false }),

  updateScript: (id, input) =>
    runAsyncRethrow(set, async () => {
      const script = await invoke<Script>("update_script", { id, input });
      set((state) => ({ scripts: state.scripts.map((s) => (s.id === id ? script : s)) }));
      return script;
    }, { recordError: false }),

  deleteScript: (id) =>
    runAsyncRethrow(set, async () => {
      await invoke("delete_script", { id });
      // A run of the deleted script would go on with no card to show it.
      if (get().run?.scriptId === id) await get().cancelRun();
      set((state) => ({
        scripts: state.scripts.filter((s) => s.id !== id),
        run: state.run?.scriptId === id ? null : state.run,
      }));
    }, { recordError: false }),

  runScript: async (scriptId, steps) => {
    if (get().running) return;
    const update = (connectionId: string, patch: Partial<ScriptRunStep>) =>
      set((state) =>
        state.run?.scriptId === scriptId
          ? {
              run: {
                ...state.run,
                steps: state.run.steps.map((s) =>
                  s.connectionId === connectionId ? { ...s, ...patch } : s,
                ),
              },
            }
          : {},
      );
    set({
      running: true,
      cancelling: false,
      run: { scriptId, runNumber: null, steps: steps.map((s) => ({ ...s, status: "running" })) },
    });
    try {
      const run = await invoke<number>("begin_script_run");
      const current = get().run;
      // The script was deleted while the run was being numbered.
      if (current?.scriptId !== scriptId) return;
      set({ run: { ...current, runNumber: run } });
      await Promise.all(
        steps.map(async ({ connectionId }) => {
          try {
            const result = await invoke<ScriptResult>("run_script", { scriptId, connectionId, run });
            update(connectionId, { status: scriptStatus(result), result });
          } catch (err) {
            update(connectionId, { status: "error", error: errorMessage(err) });
          }
        }),
      );
    } catch (err) {
      // Numbering the run failed, so no host started.
      const error = errorMessage(err);
      for (const { connectionId } of steps) update(connectionId, { status: "error", error });
    } finally {
      set({ running: false, cancelling: false });
    }
  },

  cancelRun: async () => {
    const runNumber = get().run?.runNumber;
    if (!get().running || runNumber == null) return;
    set({ cancelling: true });
    try {
      await invoke("cancel_script_run", { run: runNumber });
    } catch {
      set({ cancelling: false });
    }
  },
}));
