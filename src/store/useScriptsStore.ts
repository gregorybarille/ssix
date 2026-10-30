import { create } from "zustand";
import type { Script, ScriptInput, ScriptResult } from "@/types";
import { invoke } from "@/lib/tauri";
import { runAsync, runAsyncRethrow } from "@/lib/asyncAction";
import { errorMessage } from "@/lib/errors";
import { scriptStatus, type ScriptRunStep } from "@/lib/scripts";

interface ScriptRun {
  scriptId: string;
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
  fetchScripts: () => Promise<void>;
  addScript: (input: ScriptInput) => Promise<Script>;
  updateScript: (id: string, input: ScriptInput) => Promise<Script>;
  deleteScript: (id: string) => Promise<void>;
  /** Run the script on every step's host at once; resolves when all finish. */
  runScript: (scriptId: string, steps: ScriptRunStep[]) => Promise<void>;
}

export const useScriptsStore = create<ScriptsState>((set, get) => ({
  scripts: [],
  isLoading: false,
  error: null,
  run: null,
  running: false,

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
                scriptId,
                steps: state.run.steps.map((s) =>
                  s.connectionId === connectionId ? { ...s, ...patch } : s,
                ),
              },
            }
          : {},
      );
    set({
      running: true,
      run: { scriptId, steps: steps.map((s) => ({ ...s, status: "running" })) },
    });
    try {
      await Promise.all(
        steps.map(async ({ connectionId }) => {
          try {
            const result = await invoke<ScriptResult>("run_script", { scriptId, connectionId });
            update(connectionId, { status: scriptStatus(result), result });
          } catch (err) {
            update(connectionId, { status: "error", error: errorMessage(err) });
          }
        }),
      );
    } finally {
      set({ running: false });
    }
  },
}));
