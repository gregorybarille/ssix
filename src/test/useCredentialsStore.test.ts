import { describe, it, expect, vi, beforeEach } from "vitest";
import { useCredentialsStore } from "@/store/useCredentialsStore";
import { invoke } from "@/lib/tauri";
import type { Credential } from "@/types";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

const redactedPassword: Credential = {
  id: "c1",
  name: "pw",
  username: "root",
  type: "password",
  password: "",
};

describe("useCredentialsStore — fetch-on-edit secrets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCredentialsStore.setState({ credentials: [], isLoading: false, error: null });
  });

  it("fetchCredentialSecrets invokes get_credential_secrets with the id and returns the secrets", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ password: "hunter2" });
    const secrets = await useCredentialsStore.getState().fetchCredentialSecrets("c1");
    expect(invoke).toHaveBeenCalledWith("get_credential_secrets", { id: "c1" });
    expect(secrets).toEqual({ password: "hunter2" });
  });

  it("fetchCredentialSecrets never caches secrets in store state", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ password: "hunter2", private_key: "KEY" });
    await useCredentialsStore.getState().fetchCredentialSecrets("c1");
    const snapshot = JSON.stringify(useCredentialsStore.getState());
    expect(snapshot).not.toContain("hunter2");
    expect(snapshot).not.toContain("KEY");
  });

  it("fetchCredentialSecrets normalises a null payload to an empty object", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await expect(
      useCredentialsStore.getState().fetchCredentialSecrets("c1"),
    ).resolves.toEqual({});
  });

  it("fetchCredentialSecrets rejects with the backend error", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("Credential not found");
    await expect(
      useCredentialsStore.getState().fetchCredentialSecrets("nope"),
    ).rejects.toBe("Credential not found");
  });

  it("fetchCredentials stores the redacted list as returned by the backend", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([redactedPassword]);
    await useCredentialsStore.getState().fetchCredentials();
    expect(invoke).toHaveBeenCalledWith("get_credentials");
    expect(useCredentialsStore.getState().credentials).toEqual([redactedPassword]);
  });

  it("updateCredential replaces the row with the redacted credential the backend returns", async () => {
    useCredentialsStore.setState({ credentials: [redactedPassword] });
    vi.mocked(invoke).mockResolvedValueOnce({ ...redactedPassword, username: "deploy" });
    await useCredentialsStore
      .getState()
      .updateCredential({ ...redactedPassword, username: "deploy", password: "new" });
    const [row] = useCredentialsStore.getState().credentials;
    expect(row.username).toBe("deploy");
    expect(row.password).toBe("");
  });
});
