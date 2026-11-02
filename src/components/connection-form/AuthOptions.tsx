import type { ConnectionFormSectionProps } from "./advanced";

/**
 * Authentication options of the connection form (roadmap: auth). Owned by
 * the auth stream, which adds the agent-forwarding control here; it reads
 * `advanced.agent_forwarding` and calls `onChange({ agent_forwarding })`.
 * Renders nothing until then.
 */
export function AuthOptions(_props: ConnectionFormSectionProps) {
  return null;
}
