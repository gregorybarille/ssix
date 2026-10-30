/**
 * Fetch-on-edit secrets for `CredentialForm`.
 *
 * Listed credentials are redacted (`get_credentials` never returns a
 * password, inline key or passphrase). When the form opens in edit mode it
 * calls `get_credential_secrets` for that one credential, disables the
 * secret fields and the submit button while the call is pending, prefills
 * the fetched values and moves the unsaved-changes baseline to them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CredentialForm } from "@/components/CredentialForm";
import { invoke } from "@/lib/tauri";
import type { Credential } from "@/types";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

const passwordCred: Credential = {
  id: "cred-pw",
  name: "prod-pw",
  username: "root",
  type: "password",
  password: "",
};

const inlineKeyCred: Credential = {
  id: "cred-key",
  name: "prod-key",
  username: "deploy",
  type: "ssh_key",
};

const pathKeyCred: Credential = {
  id: "cred-path",
  name: "laptop-key",
  username: "deploy",
  type: "ssh_key",
  private_key_path: "/home/u/.ssh/id_ed25519",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const secretsState = () =>
  screen.getByTestId("credential-form").getAttribute("data-secrets-state");

describe("CredentialForm — fetch-on-edit secrets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not fetch secrets for a new credential", async () => {
    render(<CredentialForm open onOpenChange={vi.fn()} credential={null} onSubmit={vi.fn()} />);
    expect(secretsState()).toBe("none");
    expect(screen.getByTestId("credential-form-password")).toBeEnabled();
    expect(screen.getByTestId("credential-form-submit")).toBeEnabled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("fetches the edited credential's secrets on open and prefills the password", async () => {
    const pending = deferred<{ password: string }>();
    vi.mocked(invoke).mockReturnValueOnce(pending.promise);
    render(
      <CredentialForm open onOpenChange={vi.fn()} credential={passwordCred} onSubmit={vi.fn()} />,
    );

    expect(invoke).toHaveBeenCalledWith("get_credential_secrets", { id: "cred-pw" });
    expect(secretsState()).toBe("loading");
    expect(screen.getByRole("status")).toHaveTextContent(/loading saved secrets/i);
    expect(screen.getByTestId("credential-form-password")).toBeDisabled();
    expect(screen.getByTestId("credential-form-submit")).toBeDisabled();
    // Non-secret fields are prefilled immediately from the redacted row.
    expect(screen.getByLabelText(/credential name/i)).toHaveValue("prod-pw");

    pending.resolve({ password: "hunter2" });
    await waitFor(() => expect(secretsState()).toBe("loaded"));
    expect(screen.getByTestId("credential-form-password")).toHaveValue("hunter2");
    expect(screen.getByTestId("credential-form-password")).toBeEnabled();
    expect(screen.getByTestId("credential-form-submit")).toBeEnabled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("infers an inline key source from the redacted row and prefills key and passphrase", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      private_key: "-----BEGIN OPENSSH PRIVATE KEY-----",
      passphrase: "pp",
    });
    render(
      <CredentialForm open onOpenChange={vi.fn()} credential={inlineKeyCred} onSubmit={vi.fn()} />,
    );
    await waitFor(() => expect(secretsState()).toBe("loaded"));
    expect(screen.getByRole("tab", { name: /paste key/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("credential-form-private-key")).toHaveValue(
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    );
    expect(screen.getByTestId("credential-form-passphrase")).toHaveValue("pp");
  });

  it("keeps the path key source and the path from the redacted row", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({});
    render(
      <CredentialForm open onOpenChange={vi.fn()} credential={pathKeyCred} onSubmit={vi.fn()} />,
    );
    await waitFor(() => expect(secretsState()).toBe("loaded"));
    expect(screen.getByRole("tab", { name: /^path$/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("credential-form-private-key-path")).toHaveValue(
      "/home/u/.ssh/id_ed25519",
    );
    expect(screen.getByTestId("credential-form-passphrase")).toHaveValue("");
  });

  it("locks the secret fields and keeps the stored secrets when the fetch fails", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    vi.mocked(invoke).mockRejectedValueOnce("failed to read secrets file");
    render(
      <CredentialForm open onOpenChange={vi.fn()} credential={passwordCred} onSubmit={onSubmit} />,
    );
    await waitFor(() => expect(secretsState()).toBe("error"));
    const alert = screen.getByTestId("credential-form-secrets-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveClass("text-destructive");
    expect(alert).toHaveTextContent(/failed to read secrets file/);
    expect(alert).toHaveTextContent(/kept unchanged/i);
    // The secret field cannot be edited, so a save can never wipe the
    // stored password; the other fields remain editable and saveable.
    expect(screen.getByTestId("credential-form-password")).toBeDisabled();
    expect(screen.getByTestId("credential-form-submit")).toBeEnabled();

    await user.clear(screen.getByLabelText(/^username/i));
    await user.type(screen.getByLabelText(/^username/i), "deploy");
    await user.click(screen.getByRole("button", { name: /update/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      id: "cred-pw",
      username: "deploy",
      keep_secrets: true,
      password: "",
    });
  });

  it("prefers the inline key when a legacy row holds both a path and an inline key", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ private_key: "INLINE" });
    render(
      <CredentialForm open onOpenChange={vi.fn()} credential={pathKeyCred} onSubmit={vi.fn()} />,
    );
    await waitFor(() => expect(secretsState()).toBe("loaded"));
    expect(screen.getByRole("tab", { name: /paste key/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("credential-form-private-key")).toHaveValue("INLINE");
  });

  it("moves the unsaved-changes baseline to the fetched secrets", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    vi.mocked(invoke).mockResolvedValueOnce({ password: "hunter2" });
    render(
      <CredentialForm open onOpenChange={onOpenChange} credential={passwordCred} onSubmit={vi.fn()} />,
    );
    await waitFor(() => expect(secretsState()).toBe("loaded"));

    // Untouched after the prefill: closing must not prompt.
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog", { name: /discard unsaved changes/i })).toBeNull();
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // Editing the prefilled secret makes the form dirty.
    onOpenChange.mockClear();
    await user.type(screen.getByTestId("credential-form-password"), "x");
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await screen.findByRole("dialog", { name: /discard unsaved changes/i });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("sends the new secret when the user changed it", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    vi.mocked(invoke).mockResolvedValueOnce({ password: "hunter2" });
    render(
      <CredentialForm open onOpenChange={vi.fn()} credential={passwordCred} onSubmit={onSubmit} />,
    );
    await waitFor(() => expect(secretsState()).toBe("loaded"));
    await user.type(screen.getByTestId("credential-form-password"), "x");
    await user.click(screen.getByRole("button", { name: /update/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      id: "cred-pw",
      keep_secrets: false,
      password: "hunter2x",
    });
  });

  it("keeps an unchanged secret server-side instead of sending it back", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    vi.mocked(invoke).mockResolvedValueOnce({ password: "hunter2" });
    render(
      <CredentialForm
        open
        onOpenChange={onOpenChange}
        credential={passwordCred}
        onSubmit={onSubmit}
      />,
    );
    await waitFor(() => expect(secretsState()).toBe("loaded"));
    await user.clear(screen.getByLabelText(/^username/i));
    await user.type(screen.getByLabelText(/^username/i), "deploy");
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      id: "cred-pw",
      username: "deploy",
      type: "password",
      keep_secrets: true,
      password: "",
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByRole("dialog", { name: /discard unsaved changes/i })).toBeNull();
  });

  it("ignores a fetch that settles after the form closed", async () => {
    const pending = deferred<{ password: string }>();
    vi.mocked(invoke).mockReturnValueOnce(pending.promise);
    const { rerender } = render(
      <CredentialForm open onOpenChange={vi.fn()} credential={passwordCred} onSubmit={vi.fn()} />,
    );
    expect(secretsState()).toBe("loading");
    rerender(
      <CredentialForm open={false} onOpenChange={vi.fn()} credential={passwordCred} onSubmit={vi.fn()} />,
    );
    pending.resolve({ password: "hunter2" });
    // Reopen as a new credential: the stale response must not leak in.
    rerender(<CredentialForm open onOpenChange={vi.fn()} credential={null} onSubmit={vi.fn()} />);
    await waitFor(() => expect(secretsState()).toBe("none"));
    expect(screen.getByTestId("credential-form-password")).toHaveValue("");
  });
});
