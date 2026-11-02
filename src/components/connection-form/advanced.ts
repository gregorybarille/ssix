import type { Connection, ConnectionAdvanced } from "@/types";

/**
 * The connection form's per-connection options (`ConnectionAdvanced`) as
 * one state object. `ConnectionForm` loads it from the edited connection,
 * tracks it for the unsaved-changes guard and spreads it into the submit
 * payload; the section components under this folder read and change it
 * through {@link ConnectionFormSectionProps}, so a roadmap stream adds its
 * inputs in its own file without editing `ConnectionForm.tsx`:
 *
 * - `AuthOptions.tsx` — agent forwarding (roadmap: auth)
 * - `SessionOptions.tsx` — keepalive, reconnect, session log (roadmap: resilience)
 * - `TerminalOptions.tsx` — font and colour overrides (roadmap: terminal-ux)
 * - `ForwardKinds.tsx` — the kind tabs and per-kind fields (roadmap: forwards)
 *
 * A new persisted option goes on `ConnectionAdvanced` in `src/types/index.ts`
 * (mirroring `ConnectionAdvanced` in `src-tauri/src/commands/connections.rs`),
 * then into {@link ADVANCED_KEYS}, which stops compiling until it is there.
 */
export interface ConnectionFormSectionProps {
  advanced: ConnectionAdvanced;
  /** Merge `partial` into the form's `advanced` state. */
  onChange: (partial: Partial<ConnectionAdvanced>) => void;
}

/**
 * Every option, in a fixed order. Loading a connection and the unsaved-changes
 * guard both follow this list, so neither can miss an option.
 */
const ADVANCED_KEYS = Object.keys({
  agent_forwarding: true,
  keepalive_interval: true,
  auto_reconnect: true,
  log_session: true,
  font_family: true,
  font_size: true,
  color_scheme: true,
  folder: true,
} satisfies Record<keyof ConnectionAdvanced, true>) as (keyof ConnectionAdvanced)[];

/** A new connection's options: everything unset means "use the setting". */
export const DEFAULT_CONNECTION_ADVANCED: ConnectionAdvanced = {
  agent_forwarding: false,
};

/** The options as the form submits them. Serde fills in whatever is unset. */
export function advancedPayload(advanced: ConnectionAdvanced): ConnectionAdvanced {
  return { ...advanced, agent_forwarding: advanced.agent_forwarding ?? false };
}

/** The options of a saved connection, for editing or cloning it. */
export function advancedFromConnection(connection: Connection): ConnectionAdvanced {
  return advancedPayload(
    Object.fromEntries(ADVANCED_KEYS.map((key) => [key, connection[key]])) as ConnectionAdvanced,
  );
}

/**
 * Stable serialization for the unsaved-changes guard: a fixed key order,
 * with unset fields as `null`, so the output never depends on insertion order.
 */
export function serializeAdvanced(advanced: ConnectionAdvanced): string {
  const options = advancedPayload(advanced);
  return JSON.stringify(ADVANCED_KEYS.map((key) => options[key] ?? null));
}
