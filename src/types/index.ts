export type CredentialKind =
  | { type: "password"; password: string }
  | {
      type: "ssh_key";
      private_key_path?: string;
      private_key?: string;
      passphrase?: string;
    };

export interface Credential {
  id: string;
  name: string;
  username: string;
  type: "password" | "ssh_key";
  password?: string;
  /** Filesystem path to the private key. Mutually exclusive with `private_key`. */
  private_key_path?: string;
  /** Inline private key contents (OpenSSH PEM). Mutually exclusive with `private_key_path`. */
  private_key?: string;
  passphrase?: string;
  /** When true: auto-created for inline auth, not shown in the credentials list. */
  is_private?: boolean;
}

export type ConnectionKind =
  | { type: "direct" }
  | {
      type: "port_forward";
      gateway_host: string;
      gateway_port: number;
      gateway_credential_id: string;
      local_port: number;
      destination_host: string;
      destination_port: number;
    }
  | {
      type: "jump_shell";
      gateway_host: string;
      gateway_port: number;
      gateway_credential_id: string;
      destination_host: string;
      destination_port: number;
    };

export type ConnectionType = "direct" | "port_forward" | "jump_shell";

/**
 * Audit-4 Phase 4b: shared fields on every connection regardless of
 * variant. Mirrors the top-level fields of Rust's `Connection` struct
 * (with `ConnectionKind` flattened into it via serde).
 */
interface ConnectionBase {
  id: string;
  name: string;
  host: string;
  port: number;
  /**
   * For `direct` and `jump_shell` this is the destination credential.
   * For `port_forward` this is unused (the gateway credential lives on the kind fields).
   */
  credential_id?: string;
  /** SSH verbosity level: 0 = silent, 1 = info, 2 = debug (libssh2 trace). */
  verbosity?: number;
  /** Additional SSH flags, e.g. "-C" for compression. */
  extra_args?: string;
  /** Command to run after login, e.g. `sudo su - deploy`. */
  login_command?: string;
  /** Preferred starting directory on the remote host. */
  remote_path?: string;
  /** Free-form tags used for filtering/search. Empty when omitted. */
  tags?: string[];
  /** Optional Open Color name used as the terminal-tab accent. */
  color?: string;
}

export interface DirectConnection extends ConnectionBase {
  type: "direct";
}

export interface PortForwardConnection extends ConnectionBase {
  type: "port_forward";
  gateway_host: string;
  gateway_port: number;
  gateway_credential_id: string;
  local_port: number;
  destination_host: string;
  destination_port: number;
}

export interface JumpShellConnection extends ConnectionBase {
  type: "jump_shell";
  gateway_host: string;
  gateway_port: number;
  gateway_credential_id: string;
  destination_host: string;
  destination_port: number;
}

/**
 * Discriminated union — narrowing on `conn.type` gives you exactly the
 * fields that variant has, with no `!` non-null assertions or
 * `?? defaults` papering over missing data. Mirrors Rust's `Connection`
 * + `ConnectionKind` (which uses `#[serde(flatten)]`).
 *
 * Migration note: prior to Phase 4b, Connection was a flat interface
 * with every kind-specific field marked optional. That worked because
 * the runtime data is identical, but it forced consumers to either
 * assert non-null or guard at every access. Renaming `type` → `kind`
 * was considered and rejected to keep the wire format stable.
 */
export type Connection = DirectConnection | PortForwardConnection | JumpShellConnection;

/**
 * Distributive Omit. The built-in `Omit<U, K>` over a union `U` collapses
 * the union into a single intersected shape, which destroys the
 * discriminated-union narrowing. This variant maps over each member.
 *
 * Used for `ConnectionInput = DistributiveOmit<Connection, "id">` so that
 * `if (input.type === "port_forward")` still narrows.
 */
export type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;

export type ConnectionInput = DistributiveOmit<Connection, "id">;

/**
 * Type guard for the (rare) case where you have a Connection but want
 * the gateway-related fields without a switch.
 */
export function hasGateway(
  conn: Connection,
): conn is PortForwardConnection | JumpShellConnection {
  return conn.type === "port_forward" || conn.type === "jump_shell";
}

/**
 * Audit-4 Phase 4b: form-only "every-field-optional" view of a
 * Connection. The form is a builder UI that lets the user fill in any
 * combination of fields and only commits to a specific variant on
 * submit (where it's narrowed back to a `Connection`). We deliberately
 * keep this flat shape OUT of the public Connection type so consumers
 * (lists, command builders, terminal, etc.) get the union's safety;
 * only ConnectionForm and a couple of helpers reach for ConnectionDraft.
 */
export type ConnectionDraft = {
  id?: string;
  name: string;
  host: string;
  port: number;
  credential_id?: string;
  type: ConnectionType;
  verbosity?: number;
  extra_args?: string;
  login_command?: string;
  remote_path?: string;
  tags?: string[];
  color?: string;
  gateway_host?: string;
  gateway_port?: number;
  gateway_credential_id?: string;
  local_port?: number;
  destination_host?: string;
  destination_port?: number;
};

export type LayoutMode = "list" | "tile";
export type OpenMode = "tab" | "split_right" | "split_down";

export interface AppSettings {
  font_size: number;
  font_family: string;
  color_scheme: string;
  theme: string;
  connection_layout: LayoutMode;
  credential_layout: LayoutMode;
  tunnel_layout: LayoutMode;
  default_open_mode: OpenMode;
  /**
   * When true, selecting text in a terminal pane immediately copies it to the
   * system clipboard (xterm-style auto-copy). Defaults to `false` so that
   * highlighting text never silently overwrites the user's existing clipboard
   * — a privacy-relevant footgun on macOS where the convention is explicit
   * Cmd+C. Cmd/Ctrl+C still copies the active selection regardless of this
   * setting.
   */
  auto_copy_selection: boolean;
  git_sync_repo_path?: string;
  git_sync_remote: string;
  git_sync_branch?: string;
}

export interface GitSyncStatus {
  configured: boolean;
  repo_path?: string;
  branch?: string;
  remote?: string;
  has_local_changes: boolean;
  has_remote_changes: boolean;
  ahead: number;
  behind: number;
  changed_files: string[];
}

export interface GitSyncDiff {
  staged: string;
  unstaged: string;
}

export interface GitSyncSnapshot {
  repo_path: string;
  exported_files: string[];
}

/**
 * Audit-4 Phase 4: shape returned by every git_sync action that runs a
 * single git subprocess (fetch/pull/push/commit). The store inlined
 * `{ stdout: string; stderr: string }` four times — extracting it here
 * keeps the contract documented in one place and gives the Rust side a
 * single struct to mirror when ts-rs is adopted in Phase 6.
 */
export interface GitSyncActionResult {
  stdout: string;
  stderr: string;
}

export interface GitSyncRunResult {
  steps: string[];
  output: {
    stdout: string;
    stderr: string;
    status: number;
  };
}

export interface ScpResult {
  local_path: string;
  remote_path: string;
  bytes: number;
  entries?: number;
}

export interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error" | "debug" | string;
  source: string;
  message: string;
}

export const OPEN_COLORS = [
  "blue",
  "green",
  "red",
  "yellow",
  "grape",
  "cyan",
  "pink",
  "orange",
  "teal",
  "violet",
  "indigo",
  "lime",
] as const;

export type OpenColor = (typeof OPEN_COLORS)[number];

export const FONT_FAMILIES = [
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Source Code Pro",
  "Hack",
  "Inconsolata",
] as const;

export const FONT_SIZES = [10, 12, 13, 14, 16, 18, 20] as const;
