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
 * then into {@link DEFAULT_CONNECTION_ADVANCED} and {@link advancedFromConnection}.
 */
export interface ConnectionFormSectionProps {
  advanced: ConnectionAdvanced;
  /** Merge `partial` into the form's `advanced` state. */
  onChange: (partial: Partial<ConnectionAdvanced>) => void;
}

/** A new connection's options: everything unset means "use the setting". */
export const DEFAULT_CONNECTION_ADVANCED: ConnectionAdvanced = {
  agent_forwarding: false,
};

/** The options of a saved connection, for editing or cloning it. */
export function advancedFromConnection(connection: Connection): ConnectionAdvanced {
  return {
    agent_forwarding: connection.agent_forwarding ?? false,
    keepalive_interval: connection.keepalive_interval,
    auto_reconnect: connection.auto_reconnect,
    log_session: connection.log_session,
    font_family: connection.font_family,
    font_size: connection.font_size,
    color_scheme: connection.color_scheme,
    folder: connection.folder,
  };
}

/**
 * The options as the form submits them: unset fields are left out so the
 * payload only carries what the user chose (serde fills the defaults).
 */
export function advancedPayload(advanced: ConnectionAdvanced): ConnectionAdvanced {
  const payload: ConnectionAdvanced = { agent_forwarding: advanced.agent_forwarding ?? false };
  for (const key of Object.keys(advanced) as (keyof ConnectionAdvanced)[]) {
    if (key !== "agent_forwarding" && advanced[key] !== undefined) {
      Object.assign(payload, { [key]: advanced[key] });
    }
  }
  return payload;
}

/**
 * Stable serialization for the unsaved-changes guard: a fixed key order,
 * with unset fields as `null`, so the output never depends on insertion order.
 */
export function serializeAdvanced(advanced: ConnectionAdvanced): string {
  return JSON.stringify([
    advanced.agent_forwarding ?? false,
    advanced.keepalive_interval ?? null,
    advanced.auto_reconnect ?? null,
    advanced.log_session ?? null,
    advanced.font_family ?? null,
    advanced.font_size ?? null,
    advanced.color_scheme ?? null,
    advanced.folder ?? null,
  ]);
}
