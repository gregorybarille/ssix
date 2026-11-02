import type { CredentialType } from "@/types";

/**
 * The kind tabs the credential form offers, in order. Owned by the auth
 * stream (roadmap: auth). The form renders one tab per entry and a
 * `<TabsContent>` panel for each kind. The `testId` is the tab `data-testid`
 * (see `e2e/helpers/selectors.ts`).
 */
export const CREDENTIAL_KIND_TABS: ReadonlyArray<{
  type: CredentialType;
  label: string;
  testId: string;
}> = [
  { type: "password", label: "Password", testId: "credential-form-kind-password" },
  { type: "ssh_key", label: "SSH Key", testId: "credential-form-kind-sshkey" },
  { type: "agent", label: "SSH Agent", testId: "credential-form-kind-agent" },
];
