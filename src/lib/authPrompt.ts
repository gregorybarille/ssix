/**
 * Keyboard-interactive prompts as a terminal pane receives them.
 *
 * While a shell logs in, the backend sends the server's questions on the
 * session's output channel, as JSON next to its bytes (`AuthEvent` in
 * `src-tauri/src/auth_prompt.rs`). Every prompt ends with a closed event,
 * whatever became of it. `useAuthPromptStore` holds the open ones.
 */

export interface AuthPromptField {
  text: string;
  /** Whether the server allows showing the answer as it is typed. */
  echo: boolean;
}

export interface AuthPromptRequest {
  prompt_id: string;
  /** `host:port` of the server asking. */
  host: string;
  username: string;
  instructions: string;
  prompts: AuthPromptField[];
}

export type AuthEvent =
  | ({ kind: "auth_prompt" } & AuthPromptRequest)
  | { kind: "auth_prompt_closed"; prompt_id: string };

function isField(value: unknown): value is AuthPromptField {
  const field = value as Partial<AuthPromptField> | null;
  return typeof field?.text === "string" && typeof field.echo === "boolean";
}

/** The auth event in a channel message, or `null` when it holds anything else. */
export function parseAuthEvent(payload: unknown): AuthEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Partial<AuthPromptRequest> & { kind?: unknown };
  if (typeof p.prompt_id !== "string") return null;
  if (p.kind === "auth_prompt_closed") {
    return { kind: "auth_prompt_closed", prompt_id: p.prompt_id };
  }
  if (
    p.kind === "auth_prompt" &&
    typeof p.host === "string" &&
    typeof p.username === "string" &&
    typeof p.instructions === "string" &&
    Array.isArray(p.prompts) &&
    p.prompts.every(isField)
  ) {
    return {
      kind: "auth_prompt",
      prompt_id: p.prompt_id,
      host: p.host,
      username: p.username,
      instructions: p.instructions,
      prompts: p.prompts,
    };
  }
  return null;
}
