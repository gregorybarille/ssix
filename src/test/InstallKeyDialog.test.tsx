import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { InstallKeyDialog } from "../components/InstallKeyDialog";

describe("InstallKeyDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls ssh_install_public_key_by_credential with prefilled values", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    render(
      <InstallKeyDialog
        open={true}
        onOpenChange={() => {}}
        credentialId="cred-1"
        defaultHost="example.com"
        defaultPort={2222}
        defaultUsername="root"
      />
    );

    expect((screen.getByLabelText(/Host/i) as HTMLInputElement).value).toBe(
      "example.com"
    );
    expect((screen.getByLabelText(/Username/i) as HTMLInputElement).value).toBe(
      "root"
    );

    fireEvent.change(screen.getByLabelText(/One-time Password/i), {
      target: { value: "p" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Install/i }));

    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        "ssh_install_public_key_by_credential",
        expect.objectContaining({
          input: expect.objectContaining({
            credential_id: "cred-1",
            host: "example.com",
            port: 2222,
            username: "root",
            password: "p",
          }),
        })
      );
    });
  });

  it("surfaces backend error", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("auth failed");
    render(
      <InstallKeyDialog
        open={true}
        onOpenChange={() => {}}
        credentialId="cred-1"
        defaultHost="h"
        defaultUsername="u"
      />
    );
    fireEvent.change(screen.getByLabelText(/One-time Password/i), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Install/i }));
    await screen.findByText(/auth failed/);
  });
});
