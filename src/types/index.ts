export type CredentialKind =
  | { type: "password"; password: string }
  | { type: "ssh_key"; private_key_path: string; passphrase?: string };

export interface Credential {
  id: string;
  name: string;
  username: string;
  type: "password" | "ssh_key";
  password?: string;
  private_key_path?: string;
  passphrase?: string;
}

export type ConnectionKind =
  | { type: "direct" }
  | {
      type: "tunnel";
      gateway_host: string;
      gateway_port: number;
      gateway_credential_id?: string;
      destination_host: string;
      destination_port: number;
    };

export interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  credential_id?: string;
  type: "direct" | "tunnel";
  gateway_host?: string;
  gateway_port?: number;
  gateway_credential_id?: string;
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
