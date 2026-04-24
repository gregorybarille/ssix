/**
 * Audit-4 Phase 6a: structural parity between hand-written
 * `src/types/index.ts` and the ts-rs-generated bindings in
 * `src/types/generated/`.
 *
 * Why a runtime test rather than a `type Hand = Generated` assertion?
 *
 * The generators differ on `optional vs nullable`:
 *   - ts-rs emits `field: T | null` for every `Option<T>` (always
 *     present, possibly null) because that's the only way to represent
 *     `Option<T>` in TS without losing the property at compile time.
 *   - The hand-written types use `field?: T` (may be absent) because
 *     serde's `#[serde(skip_serializing_if = "Option::is_none")]`
 *     means absent fields are normal on the wire.
 *
 * Both views are correct and round-trip identically through JSON, but
 * they are NOT mutually assignable in strict TypeScript. So instead of
 * checking type compatibility, we extract the *field name set* from a
 * representative instance of each generated shape (built at compile
 * time so tsc validates the shape), and assert every name shows up
 * somewhere in the corresponding hand-written interface's instance.
 *
 * If a Rust developer adds a new field to `Connection` and forgets to
 * mirror it in `index.ts`, the generated binding gains the field,
 * the sample below fails to compile (or at runtime, the parity check
 * reports the missing field). Either failure mode catches the drift.
 */

import { describe, it, expect } from "vitest";
import type { AppData as GenAppData } from "@/types/generated/AppData";
import type { AppSettings as GenAppSettings } from "@/types/generated/AppSettings";
import type { Connection as GenConnection } from "@/types/generated/Connection";
import type { Credential as GenCredential } from "@/types/generated/Credential";
import type {
  AppSettings as HandAppSettings,
  Connection as HandConnection,
  Credential as HandCredential,
} from "@/types";

// Build a fully-populated instance of each generated shape. tsc will
// fail the build if a new field is added on the Rust side without
// being added here.
const genConnection: GenConnection = {
  id: "id",
  name: "n",
  host: "h",
  port: 22,
  credential_id: null,
  verbosity: 0,
  extra_args: null,
  login_command: null,
  remote_path: null,
  tags: [],
  color: null,
  type: "direct",
};

const genCredential: GenCredential = {
  id: "id",
  name: "n",
  username: "u",
  is_private: false,
  type: "password",
  password: "p",
};

const genSettings: GenAppSettings = {
  font_size: 14,
  font_family: "JetBrains Mono",
  color_scheme: "blue",
  theme: "dark",
  connection_layout: "list",
  credential_layout: "list",
  tunnel_layout: "list",
  default_open_mode: "tab",
  auto_copy_selection: false,
  git_sync_repo_path: null,
  git_sync_remote: "origin",
  git_sync_branch: null,
};

// Same fields against the hand-written types (with `null` swapped to
// either omission or matching union members where the hand-written
// signature requires it). tsc still validates these.
const handConnection: HandConnection = {
  id: "id",
  name: "n",
  host: "h",
  port: 22,
  type: "direct",
};

const handCredential: HandCredential = {
  id: "id",
  name: "n",
  username: "u",
  type: "password",
  password: "p",
};

const handSettings: HandAppSettings = {
  font_size: 14,
  font_family: "JetBrains Mono",
  color_scheme: "blue",
  theme: "dark",
  connection_layout: "list",
  credential_layout: "list",
  tunnel_layout: "list",
  default_open_mode: "tab",
  auto_copy_selection: false,
  git_sync_remote: "origin",
};

/**
 * Returns the set of field names declared on a value, treating
 * undefined and null both as "field exists." For the hand-written
 * side we also need to seed optional fields the test instance left
 * out — so callers pass an explicit allow-list of optional names.
 */
function fieldSet(obj: object, optionalExtras: string[] = []): Set<string> {
  return new Set([...Object.keys(obj), ...optionalExtras]);
}

describe("Phase 6a — ts-rs parity (Rust models <-> TS index.ts)", () => {
  it("Connection: every generated field exists on the hand-written union", () => {
    // Hand-written Connection is a union; the discriminator decides
    // which fields are present. To check parity we list every field
    // the union *can* have across all variants, plus the always-
    // present base fields.
    const handAllFields = new Set([
      ...Object.keys(handConnection),
      // ConnectionBase optional fields not set on the test instance:
      "credential_id",
      "verbosity",
      "extra_args",
      "login_command",
      "remote_path",
      "tags",
      "color",
      // PortForward / JumpShell variant fields:
      "gateway_host",
      "gateway_port",
      "gateway_credential_id",
      "local_port",
      "destination_host",
      "destination_port",
    ]);

    const genFields = fieldSet(genConnection);
    const missing = [...genFields].filter((f) => !handAllFields.has(f));
    expect(missing, `Hand-written Connection is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("Credential: every generated field exists on the hand-written interface", () => {
    const handAllFields = new Set([
      ...Object.keys(handCredential),
      // Optional fields not set on the test instance:
      "is_private",
      "private_key_path",
      "private_key",
      "passphrase",
    ]);

    const genFields = fieldSet(genCredential);
    const missing = [...genFields].filter((f) => !handAllFields.has(f));
    expect(missing, `Hand-written Credential is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("AppSettings: every generated field exists on the hand-written interface", () => {
    const handAllFields = fieldSet(handSettings, [
      "git_sync_repo_path",
      "git_sync_branch",
    ]);

    const genFields = fieldSet(genSettings);
    const missing = [...genFields].filter((f) => !handAllFields.has(f));
    expect(missing, `Hand-written AppSettings is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("AppData: schema_version is exported by ts-rs and the wire field is snake_case", () => {
    // Light sanity check; AppData isn't mirrored in index.ts as a
    // standalone shape (the frontend reaches into AppData fields
    // through individual Zustand stores), so we only assert the
    // generated binding contains schema_version (the field added in
    // Phase 6b that the migration shim depends on).
    const sample: GenAppData = {
      schema_version: 1,
      credentials: [],
      connections: [],
      settings: genSettings,
    };
    expect(Object.keys(sample)).toContain("schema_version");
  });
});
