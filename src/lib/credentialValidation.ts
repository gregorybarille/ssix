/**
 * Required-field checks for a credential, shared by the credential form and
 * the inline Password / SSH Key authentication in the connection form, so
 * both reject the same drafts with the same messages.
 */

export type CredentialFieldKey = "name" | "username" | "password" | "key_path" | "key_inline";

export type CredentialFieldErrors = Partial<Record<CredentialFieldKey, string>>;

export interface CredentialDraft {
  /** `null` for an unnamed (private) credential, which needs no name. */
  name: string | null;
  username: string;
  type: "password" | "ssh_key";
  password?: string;
  /** Where an SSH key comes from; the inline connection form only takes a path. */
  keySource?: "path" | "inline";
  privateKeyPath?: string;
  privateKey?: string;
}

export interface CredentialRules {
  /**
   * Reject an empty password. A saved credential may have none, but the
   * connection form's inline password tab exists to collect one.
   */
  requirePassword?: boolean;
  /** The stored secrets are kept, so empty key contents are fine. */
  keepSecrets?: boolean;
  /** Names of the saved credentials; a named draft must not reuse one. */
  takenNames?: readonly string[];
}

export function credentialFieldErrors(
  draft: CredentialDraft,
  rules: CredentialRules = {},
): CredentialFieldErrors {
  const errors: CredentialFieldErrors = {};
  if (draft.name !== null) {
    const name = draft.name.trim();
    if (!name) {
      errors.name = "Credential name is required";
    } else if (rules.takenNames?.includes(name)) {
      errors.name = `A credential named '${name}' already exists`;
    }
  }
  if (!draft.username.trim()) errors.username = "Username is required";
  if (draft.type === "password") {
    if (rules.requirePassword && !draft.password) errors.password = "Password is required";
  } else if ((draft.keySource ?? "path") === "path") {
    if (!draft.privateKeyPath?.trim()) errors.key_path = "Private key path is required";
  } else if (!draft.privateKey?.trim() && !rules.keepSecrets) {
    errors.key_inline = "Private key contents are required";
  }
  return errors;
}
