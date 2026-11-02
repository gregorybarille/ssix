import { create } from "zustand";
import type { AuthEvent, AuthPromptRequest } from "@/lib/authPrompt";
import { invoke } from "@/lib/tauri";

/**
 * The keyboard-interactive prompt each terminal pane is showing, by the id of
 * the pane's session (the placeholder id: a pane still logging in has no other).
 * Holds what the server asked, never what the user answers.
 */
interface AuthPromptState {
  prompts: Record<string, AuthPromptRequest>;
  receive: (paneId: string, event: AuthEvent) => void;
  /** Send the answers. Rejects when the backend refuses them; the prompt stays. */
  answer: (paneId: string, answers: string[]) => Promise<void>;
  /** Give up on the pane's prompt, if it has one. That ends the connection attempt. */
  cancel: (paneId: string) => void;
  /** Give up on a prompt that arrived for a pane that is already gone. */
  refuse: (event: AuthEvent) => void;
}

const cancelPrompt = (promptId: string) => {
  invoke("ssh_auth_cancel", { promptId }).catch(() => {});
};

const without = (prompts: Record<string, AuthPromptRequest>, paneId: string) => {
  const { [paneId]: _removed, ...rest } = prompts;
  return rest;
};

export const useAuthPromptStore = create<AuthPromptState>((set, get) => ({
  prompts: {},

  receive: (paneId, event) => {
    set((state) => {
      if (event.kind === "auth_prompt") {
        const { kind: _kind, ...request } = event;
        return { prompts: { ...state.prompts, [paneId]: request } };
      }
      // A later round may already be showing; only its own close removes it.
      return state.prompts[paneId]?.prompt_id === event.prompt_id
        ? { prompts: without(state.prompts, paneId) }
        : state;
    });
  },

  answer: async (paneId, answers) => {
    const prompt = get().prompts[paneId];
    if (!prompt) return;
    await invoke("ssh_auth_answer", { promptId: prompt.prompt_id, answers });
  },

  cancel: (paneId) => {
    const prompt = get().prompts[paneId];
    if (!prompt) return;
    set((state) => ({ prompts: without(state.prompts, paneId) }));
    cancelPrompt(prompt.prompt_id);
  },

  refuse: (event) => {
    if (event.kind === "auth_prompt") cancelPrompt(event.prompt_id);
  },
}));
