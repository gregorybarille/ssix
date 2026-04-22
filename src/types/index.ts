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

export interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  /**
   * For `direct` and `jump_shell` this is the destination credential.
   * For `port_forward` this is unused (the gateway credential lives on the kind fields).
   */
  credential_id?: string;
  type: ConnectionType;
  /** SSH verbosity level: 0 = silent, 1 = info, 2 = debug (libssh2 trace). */
  verbosity?: number;
  /** Additional SSH flags, e.g. "-C" for compression. */
  extra_args?: string;
  gateway_host?: string;
  gateway_port?: number;
  gateway_credential_id?: string;
  local_port?: number;
  destination_host?: string;
  destination_port?: number;
}

export interface AppSettings {
  font_size: number;
  font_family: string;
  color_scheme: string;
  theme: string;
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
