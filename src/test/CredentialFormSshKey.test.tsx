import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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

  it("disables browser autocomplete on non-password fields while preserving password semantics", async () => {
    const user = userEvent.setup();
    render(
      <CredentialForm
        open={true}
        onOpenChange={() => {}}
        credential={null}
        onSubmit={vi.fn()}
      />
    );

    expect(screen.getByLabelText(/Credential Name/i)).toHaveAttribute(
      "autocomplete",
      "off",
    );
    expect(screen.getByLabelText(/^Username/i)).toHaveAttribute(
      "autocomplete",
      "off",
    );
    expect(screen.getByTestId("credential-form-password")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );

    await user.click(screen.getByRole("tab", { name: /SSH Key/i }));
    expect(await screen.findByLabelText(/Private Key Path/i)).toHaveAttribute(
      "autocomplete",
      "off",
    );

    await user.click(await screen.findByRole("tab", { name: /Paste key/i }));
    expect(
      await screen.findByLabelText(/Private Key Contents/i),
    ).toHaveAttribute("autocomplete", "off");
    expect(screen.getByLabelText(/Passphrase/i)).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
  });

  it("renders inline mode inside the app surface without a dialog wrapper", () => {
    render(
      <CredentialForm
        open={true}
        inline
        onOpenChange={() => {}}
        credential={null}
        onSubmit={vi.fn()}
      />
    );

    expect(screen.getByRole("heading", { name: /new credential/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Credential Name/i)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: /new credential/i })).toBeInTheDocument();
    expect(screen.getByTestId("credential-form")).toHaveAttribute("aria-labelledby");
  });

  it("focuses the first field and closes on Escape in inline mode", async () => {
    const onOpenChange = vi.fn();
    render(
      <CredentialForm
        open={true}
        inline
        onOpenChange={onOpenChange}
        credential={null}
        onSubmit={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(screen.getByLabelText(/Credential Name/i)).toHaveFocus(),
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
