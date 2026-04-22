import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CredentialForm } from "../components/CredentialForm";

describe("CredentialForm SSH key source toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits inline private key when 'Paste key' is selected", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CredentialForm
        open={true}
        onOpenChange={() => {}}
        credential={null}
        onSubmit={onSubmit}
      />
    );

    await user.type(screen.getByLabelText(/Credential Name/i), "inline-cred");
    await user.type(screen.getByLabelText(/Username/i), "ubuntu");
    await user.click(screen.getByRole("tab", { name: /SSH Key/i }));
    await user.click(await screen.findByRole("tab", { name: /Paste key/i }));
    await user.type(
      await screen.findByLabelText(/Private Key Contents/i),
      "-----BEGIN OPENSSH PRIVATE KEY-----"
    );
    await user.click(screen.getByRole("button", { name: /Create/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const arg = onSubmit.mock.calls[0][0];
    expect(arg.type).toBe("ssh_key");
    expect(arg.private_key).toContain("BEGIN OPENSSH");
    expect(arg.private_key_path).toBeUndefined();
  });

  it("requires a value when paste-key is empty", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <CredentialForm
        open={true}
        onOpenChange={() => {}}
        credential={null}
        onSubmit={onSubmit}
      />
    );
    await user.type(screen.getByLabelText(/Credential Name/i), "x");
    await user.type(screen.getByLabelText(/Username/i), "y");
    await user.click(screen.getByRole("tab", { name: /SSH Key/i }));
    await user.click(await screen.findByRole("tab", { name: /Paste key/i }));
    await user.click(screen.getByRole("button", { name: /Create/i }));

    await screen.findByText(/Private key contents are required/i);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

