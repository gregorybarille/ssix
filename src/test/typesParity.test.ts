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
import type { GitSyncCommitInput as GenGitSyncCommitInput } from "@/types/generated/GitSyncCommitInput";
import type { GitSyncDiff as GenGitSyncDiff } from "@/types/generated/GitSyncDiff";
import type { GitSyncRunInput as GenGitSyncRunInput } from "@/types/generated/GitSyncRunInput";
import type { GitSyncRunResult as GenGitSyncRunResult } from "@/types/generated/GitSyncRunResult";
import type { GitSyncSnapshot as GenGitSyncSnapshot } from "@/types/generated/GitSyncSnapshot";
import type { CredentialSecrets as GenCredentialSecrets } from "@/types/generated/CredentialSecrets";
import type { Script as GenScript } from "@/types/generated/Script";
import type { ScriptResult as GenScriptResult } from "@/types/generated/ScriptResult";
import type { Snippet as GenSnippet } from "@/types/generated/Snippet";
import type {
  AppSettings as HandAppSettings,
  Connection as HandConnection,
  Credential as HandCredential,
  CredentialSecrets as HandCredentialSecrets,
  GitSyncCommitInput as HandGitSyncCommitInput,
  GitSyncDiff as HandGitSyncDiff,
  GitSyncRunInput as HandGitSyncRunInput,
  GitSyncRunResult as HandGitSyncRunResult,
  GitSyncSnapshot as HandGitSyncSnapshot,
  Script as HandScript,
  ScriptResult as HandScriptResult,
  Snippet as HandSnippet,
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
  proxy_command: null,
  login_command: null,
  remote_path: null,
  tags: [],
  color: null,
  agent_forwarding: false,
  keepalive_interval: null,
  auto_reconnect: null,
  log_session: null,
  font_family: null,
  font_size: null,
  color_scheme: null,
  folder: null,
  type: "direct",
};

// The two forward kinds added by the foundation: tsc checks their fields.
const genRemoteForward: GenConnection = {
  ...genConnection,
  type: "remote_forward",
  gateway_host: "gw",
  gateway_port: 22,
  gateway_credential_id: "c",
  remote_port: 8080,
  destination_host: "127.0.0.1",
  destination_port: 3000,
};
const genDynamicForward: GenConnection = {
  ...genConnection,
  type: "dynamic_forward",
  gateway_host: "gw",
  gateway_port: 22,
  gateway_credential_id: "c",
  local_port: 1080,
};

const genCredential: GenCredential = {
  id: "id",
  name: "n",
  username: "u",
  is_private: false,
  type: "password",
  password: "p",
};

const genCredentialSecrets: GenCredentialSecrets = {
  password: "p",
  passphrase: null,
  private_key: null,
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
  backup_enabled: true,
  backup_interval_hours: 24,
  backup_keep: 10,
  keepalive_interval: 30,
  auto_reconnect: true,
  reconnect_max_attempts: 5,
  session_log_enabled: false,
  sidebar_top: [],
  sidebar_bottom: [],
  session_log_dir: null,
};

const genScript: GenScript = { id: "id", name: "n", body: "b", platform: "posix", interpreter: "sh -s" };

const genSnippet: GenSnippet = { id: "s", name: "n", command: "ls", tags: [] };

const genScriptResult: GenScriptResult = {
  stdout: "",
  stderr: "",
  exit_code: 0,
  exit_signal: null,
  duration_ms: 1,
  truncated: false,
  timed_out: false,
  cancelled: false,
  end: "exit 0",
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

const handRemoteForward: HandConnection = {
  ...handConnection,
  type: "remote_forward",
  gateway_host: "gw",
  gateway_port: 22,
  gateway_credential_id: "c",
  remote_port: 8080,
  destination_host: "127.0.0.1",
  destination_port: 3000,
};
const handDynamicForward: HandConnection = {
  ...handConnection,
  type: "dynamic_forward",
  gateway_host: "gw",
  gateway_port: 22,
  gateway_credential_id: "c",
  local_port: 1080,
};

const handAgentCredential: HandCredential = {
  id: "id",
  name: "n",
  username: "u",
  type: "agent",
};

const handCredential: HandCredential = {
  id: "id",
  name: "n",
  username: "u",
  type: "password",
  password: "p",
};

const handCredentialSecrets: HandCredentialSecrets = {
  password: "p",
  passphrase: "pp",
  private_key: "k",
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
  backup_enabled: true,
  backup_interval_hours: 24,
  backup_keep: 10,
  keepalive_interval: 30,
  auto_reconnect: true,
  reconnect_max_attempts: 5,
  session_log_enabled: false,
  sidebar_top: [],
  sidebar_bottom: [],
};

const handScript: HandScript = { id: "id", name: "n", body: "b", platform: "posix", interpreter: "sh -s" };

const handSnippet: HandSnippet = { id: "s", name: "n", command: "ls", tags: [] };

const handScriptResult: HandScriptResult = {
  stdout: "",
  stderr: "",
  duration_ms: 1,
  truncated: false,
  timed_out: false,
  cancelled: false,
  end: "exit 0",
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
      "proxy_command",
      "login_command",
      "remote_path",
      "tags",
      "color",
      // Roadmap foundation fields (ConnectionAdvanced):
      "agent_forwarding",
      "keepalive_interval",
      "auto_reconnect",
      "log_session",
      "font_family",
      "font_size",
      "color_scheme",
      "folder",
      // Variant fields: PortForward / JumpShell / RemoteForward / DynamicForward
      ...Object.keys(handRemoteForward),
      ...Object.keys(handDynamicForward),
    ]);

    const genFields = new Set([
      ...fieldSet(genConnection),
      ...fieldSet(genRemoteForward),
      ...fieldSet(genDynamicForward),
    ]);
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
    // The agent kind carries no fields of its own beyond the discriminator.
    const agent: GenCredential = { ...genCredential, type: "agent" } as GenCredential;
    expect(agent.type).toBe(handAgentCredential.type);
  });

  it("CredentialSecrets: every generated field exists on the hand-written interface", () => {
    const genFields = fieldSet(genCredentialSecrets);
    const handFields = fieldSet(handCredentialSecrets);
    const missing = [...genFields].filter((f) => !handFields.has(f));
    expect(missing, `Hand-written CredentialSecrets is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("AppSettings: every generated field exists on the hand-written interface", () => {
    const handAllFields = fieldSet(handSettings, [
      "git_sync_repo_path",
      "git_sync_branch",
      "session_log_dir",
    ]);

    const genFields = fieldSet(genSettings);
    const missing = [...genFields].filter((f) => !handAllFields.has(f));
    expect(missing, `Hand-written AppSettings is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("Script and ScriptResult: every generated field exists on the hand-written interfaces", () => {
    const scriptMissing = [...fieldSet(genScript)].filter((f) => !fieldSet(handScript).has(f));
    expect(scriptMissing, `Hand-written Script is missing: ${scriptMissing.join(", ")}`).toEqual([]);
    const handResult = fieldSet(handScriptResult, ["exit_code", "exit_signal"]);
    const resultMissing = [...fieldSet(genScriptResult)].filter((f) => !handResult.has(f));
    expect(resultMissing, `Hand-written ScriptResult is missing: ${resultMissing.join(", ")}`).toEqual([]);
  });

  it("Git Sync run: the generated and hand-written shapes accept each other", () => {
    const genResult: GenGitSyncRunResult = {
      steps: [],
      output: { stdout: "", stderr: "" },
      at_risk: [],
    };
    const handResult: HandGitSyncRunResult = genResult;
    const genInput: GenGitSyncRunInput = { agreed: [] };
    const handInput: HandGitSyncRunInput = genInput;
    const genCommit: GenGitSyncCommitInput = { message: "m", agreed: [] };
    const handCommit: HandGitSyncCommitInput = genCommit;
    const genSnapshot: GenGitSyncSnapshot = { repo_path: "r", exported_files: [], at_risk: [] };
    const handSnapshot: HandGitSyncSnapshot = genSnapshot;
    const genDiff: GenGitSyncDiff = { staged: "", unstaged: "", at_risk: [] };
    const handDiff: HandGitSyncDiff = genDiff;
    expect(handResult).toBe(genResult);
    expect(handInput).toBe(genInput);
    expect(handCommit).toBe(genCommit);
    expect(handSnapshot).toBe(genSnapshot);
    expect(handDiff).toBe(genDiff);
  });

  it("Snippet: every generated field exists on the hand-written interface", () => {
    const missing = [...fieldSet(genSnippet)].filter((f) => !fieldSet(handSnippet).has(f));
    expect(missing, `Hand-written Snippet is missing: ${missing.join(", ")}`).toEqual([]);
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
      scripts: [genScript],
      snippets: [genSnippet],
    };
    expect(Object.keys(sample)).toContain("schema_version");
    expect(Object.keys(sample)).toContain("snippets");
  });
});
