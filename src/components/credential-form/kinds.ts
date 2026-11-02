import type { CredentialType } from "@/types";

/**
 * The kind tabs the credential form offers, in order. Owned by the auth
 * stream (roadmap: auth), which appends `agent` here once the SSH agent can
 * be used; the form renders one tab per entry and a `<TabsContent>` panel
 * for each kind that has fields. The `testId` is the tab's `data-testid`
 * (see `e2e/helpers/selectors.ts`).
 */
export const CREDENTIAL_KIND_TABS: ReadonlyArray<{
  type: CredentialType;
  label: string;
  testId: string;
}> = [
  { type: "password", label: "Password", testId: "credential-form-kind-password" },
  { type: "ssh_key", label: "SSH Key", testId: "credential-form-kind-sshkey" },
];
