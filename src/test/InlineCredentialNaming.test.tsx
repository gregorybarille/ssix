import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionForm } from "@/components/ConnectionForm";
import { Credential } from "@/types";

const baseCredentialMock = async (data: any) => ({
  id: "cred-123",
  name: data.name,
  username: data.username,
  type: data.type,
  password: data.password,
  private_key_path: data.private_key_path,
  passphrase: data.passphrase,
  is_private: data.is_private,
});

describe("ConnectionForm inline credential naming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const fillRequiredFields = () => {
    fireEvent.change(screen.getByLabelText(/connection name/i), {
      target: { value: "my-server" },
    });
    fireEvent.change(screen.getByLabelText(/host \*/i), {
      target: { value: "example.com" },
    });
  };

  const openPasswordTab = async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /password/i }));
  };

  it("lets the user override the generated credential name when saving inline auth", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onCreateCredential = vi.fn(baseCredentialMock);
    render(
      <ConnectionForm
        open
        onOpenChange={vi.fn()}
        credentials={[]}
        onSubmit={onSubmit}
        onCreateCredential={onCreateCredential}
      />
    );

    fillRequiredFields();
    await openPasswordTab();
    const usernameInput = await screen.findByPlaceholderText("root");
    fireEvent.change(usernameInput, {
      target: { value: "root" },
    });
    const passwordInput = await screen.findByPlaceholderText("••••••••");
    fireEvent.change(passwordInput, {
      target: { value: "s3cr3t" },
    });

    fireEvent.click(
      screen.getByLabelText(/Save as a named credential/i)
    );

    const nameInput = await screen.findByLabelText(/credential name \*/i);
    expect((nameInput as HTMLInputElement).value).toBe("my-server-cred");
    fireEvent.change(nameInput, { target: { value: "custom-cred" } });

    fireEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => expect(onCreateCredential).toHaveBeenCalledTimes(1));
    expect(onCreateCredential.mock.calls[0][0].name).toBe("custom-cred");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "my-server",
        host: "example.com",
        type: "direct",
        credential_id: "cred-123",
      })
    );
  });

  it("surfaces a validation error when the generated credential name already exists", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onCreateCredential = vi.fn(baseCredentialMock);
    const credentials: Credential[] = [
      {
        id: "existing",
        name: "my-server-cred",
        username: "root",
        type: "password",
        password: "",
      },
    ];

    render(
      <ConnectionForm
        open
        onOpenChange={vi.fn()}
        credentials={credentials}
        onSubmit={onSubmit}
        onCreateCredential={onCreateCredential}
      />
    );

    fillRequiredFields();
    await openPasswordTab();
    const usernameInput = await screen.findByPlaceholderText("root");
    fireEvent.change(usernameInput, {
      target: { value: "root" },
    });
    const passwordInput = await screen.findByPlaceholderText("••••••••");
    fireEvent.change(passwordInput, {
      target: { value: "s3cr3t" },
    });
    fireEvent.click(
      screen.getByLabelText(/Save as a named credential/i)
    );

    fireEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/A credential named 'my-server-cred' already exists/i)
      ).toBeInTheDocument()
    );
    expect(onCreateCredential).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
