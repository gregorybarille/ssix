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

  /*
   * P2-A10: success message must live in role=status / aria-live=polite
   * (not in the visual-only green box of the previous version), and the
   * dialog must NOT auto-close — the prior 800ms setTimeout raced AT
   * announcement and dismissed the dialog mid-message. The user closes
   * via the "Done" button.
   */
  it("renders success in role=status with aria-live=polite and does NOT auto-close", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    const onOpenChange = vi.fn();
    render(
      <InstallKeyDialog
        open={true}
        onOpenChange={onOpenChange}
        credentialId="cred-1"
        defaultHost="h"
        defaultUsername="u"
      />,
    );
    fireEvent.change(screen.getByLabelText(/One-time Password/i), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Install$/i }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/installed successfully/i);
    expect(status).toHaveAttribute("aria-live", "polite");
    // Wait longer than the previous 800ms auto-close window. The
    // dialog must remain open until the user dismisses it.
    await new Promise((r) => setTimeout(r, 1000));
    expect(onOpenChange).not.toHaveBeenCalled();
    // Footer cancel button now reads "Done" once success is shown.
    expect(
      screen.getByRole("button", { name: /^Done$/i }),
    ).toBeInTheDocument();
  });

  it("renders submit error in role=alert with aria-live=assertive", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("auth failed");
    render(
      <InstallKeyDialog
        open={true}
        onOpenChange={() => {}}
        credentialId="cred-1"
        defaultHost="h"
        defaultUsername="u"
      />,
    );
    fireEvent.change(screen.getByLabelText(/One-time Password/i), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Install$/i }));
    const alert = await screen.findByText(/auth failed/i);
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });
});
