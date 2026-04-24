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

  /*
   * P2-A3: the Port field used to silently fall back to 22 on
   * invalid input. AGENTS.md mandates parsePort + inline aria-invalid
   * + role="alert" + submit blocked while invalid. These assertions
   * lock that contract in.
   */
  it("blocks submit and shows an inline alert when the port is out of range", () => {
    render(
      <InstallKeyDialog
        open={true}
        onOpenChange={() => {}}
        credentialId="cred-1"
        defaultHost="h"
        defaultUsername="u"
      />,
    );
    const portInput = screen.getByLabelText(/^Port$/i);
    fireEvent.change(portInput, { target: { value: "99999" } });
    expect(portInput).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(/between 1 and 65535/i);
    expect(screen.getByRole("button", { name: /Install/i })).toBeDisabled();
  });

  it("blocks submit when the port field is empty", () => {
    render(
      <InstallKeyDialog
        open={true}
        onOpenChange={() => {}}
        credentialId="cred-1"
        defaultHost="h"
        defaultUsername="u"
      />,
    );
    const portInput = screen.getByLabelText(/^Port$/i);
    fireEvent.change(portInput, { target: { value: "" } });
    expect(portInput).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(/required/i);
    expect(screen.getByRole("button", { name: /Install/i })).toBeDisabled();
  });

  it("does NOT silently coerce non-numeric port input to 22", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    render(
      <InstallKeyDialog
        open={true}
        onOpenChange={() => {}}
        credentialId="cred-1"
        defaultHost="h"
        defaultUsername="u"
      />,
    );
    fireEvent.change(screen.getByLabelText(/^Port$/i), {
      target: { value: "abc" },
    });
    fireEvent.change(screen.getByLabelText(/One-time Password/i), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Install/i }));
    // Submit must NOT have been dispatched with a fallback port.
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/whole number/i);
  });
});
