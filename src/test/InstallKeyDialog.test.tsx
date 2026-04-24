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

  /*
   * Audit-3 follow-up P2#7: after a successful install we leave
   * the dialog open and disable Install (so the user reads the
   * success message), but if they then edit Host/Port/Username
   * they're targeting a *different* host and the button must
   * re-enable. Also: the Install button label flips to "Installed"
   * (was: still "Install" but disabled — the disabled state was
   * not visible to AT and confused sighted users into clicking it
   * repeatedly).
   */
  it("after success, button labels Installed and re-enables on host edit", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    render(
      <InstallKeyDialog
        open
        onOpenChange={() => {}}
        credentialId="cred-1"
        defaultHost="a.example"
        defaultPort={22}
        defaultUsername="root"
      />,
    );
    fireEvent.change(screen.getByLabelText(/One-time Password/i), {
      target: { value: "p" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Install$/i }));
    // After success, the button text is "Installed" and it's disabled.
    const installedBtn = await screen.findByRole("button", { name: /Installed/i });
    expect(installedBtn).toBeDisabled();
    // Editing host re-enables the button.
    fireEvent.change(screen.getByLabelText(/Host/i), {
      target: { value: "b.example" },
    });
    const installBtn = screen.getByRole("button", { name: /^Install$/i });
    expect(installBtn).not.toBeDisabled();
  });

  it("submit button carries aria-busy while installing", async () => {
    let resolveInvoke: (v: undefined) => void = () => {};
    vi.mocked(invoke).mockImplementationOnce(
      () => new Promise<undefined>((res) => { resolveInvoke = res; }),
    );
    render(
      <InstallKeyDialog
        open
        onOpenChange={() => {}}
        credentialId="cred-1"
        defaultHost="a.example"
        defaultUsername="root"
      />,
    );
    fireEvent.change(screen.getByLabelText(/One-time Password/i), {
      target: { value: "p" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Install$/i }));
    // While the in-flight invoke is pending, the button advertises busy.
    const busyBtn = await screen.findByRole("button", { name: /Installing/i });
    expect(busyBtn).toHaveAttribute("aria-busy", "true");
    resolveInvoke(undefined);
  });

  /*
   * Audit-3 follow-up P2#6: required text fields advertise
   * required-state to AT via aria-required, not just a visual
   * '*' in the label. The asterisk is announced inconsistently
   * (some screen readers read 'asterisk', some skip it). On
   * submit error, the corresponding empty field flips
   * aria-invalid so AT can locate the offending control.
   */
  it("marks required text fields with aria-required and flips aria-invalid on blank submit", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Username is required"));
    render(
      <InstallKeyDialog
        open={true}
        onOpenChange={() => {}}
        credentialId="cred-1"
      />
    );

    const host = screen.getByLabelText(/Host/i) as HTMLInputElement;
    const user = screen.getByLabelText(/Username/i) as HTMLInputElement;
    const pw = screen.getByLabelText(/One-time Password/i) as HTMLInputElement;

    expect(host).toHaveAttribute("aria-required", "true");
    expect(user).toHaveAttribute("aria-required", "true");
    expect(pw).toHaveAttribute("aria-required", "true");

    // Provide host so the submit doesn't bail on the inline port-only
    // check, then submit with blank user/password and let the backend
    // error trigger the per-field aria-invalid.
    fireEvent.change(host, { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /^Install$/i }));

    await screen.findByRole("alert");
    expect(user).toHaveAttribute("aria-invalid", "true");
    expect(pw).toHaveAttribute("aria-invalid", "true");
    // Host was provided so it should NOT be marked invalid.
    expect(host).toHaveAttribute("aria-invalid", "false");
  });
});
