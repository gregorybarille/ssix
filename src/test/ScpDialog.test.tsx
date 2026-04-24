import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScpDialog } from "@/components/ScpDialog";
import { invoke } from "@/lib/tauri";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

describe("ScpDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits upload requests", async () => {
    vi.mocked(invoke).mockResolvedValue({
      local_path: "/tmp/local.txt",
      remote_path: "/srv/app/local.txt",
      bytes: 12,
      entries: 1,
    });

    render(
      <ScpDialog
        open
        onOpenChange={vi.fn()}
        connection={{ id: "c1", name: "prod", host: "host", port: 22, type: "direct", remote_path: "/srv/app" }}
      />
    );

    fireEvent.change(screen.getByLabelText(/local path/i), { target: { value: "/tmp/local.txt" } });
    fireEvent.click(screen.getByRole("button", { name: /upload/i }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("scp_upload", expect.any(Object)));
    expect(await screen.findByText(/Transferred 12 bytes/)).toBeInTheDocument();
  });

  it("passes the recursive option through", async () => {
    vi.mocked(invoke).mockResolvedValue({
      local_path: "/tmp/dir",
      remote_path: "/srv/app/dir",
      bytes: 120,
      entries: 3,
    });

    render(
      <ScpDialog
        open
        onOpenChange={vi.fn()}
        connection={{ id: "c1", name: "prod", host: "host", port: 22, type: "direct", remote_path: "/srv/app" }}
      />
    );

    fireEvent.change(screen.getByLabelText(/local path/i), { target: { value: "/tmp/dir" } });
    fireEvent.click(screen.getByLabelText(/transfer directories recursively/i));
    fireEvent.click(screen.getByRole("button", { name: /upload/i }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "scp_upload",
        expect.objectContaining({
          input: expect.objectContaining({ recursive: true }),
        })
      )
    );
  });

  /*
   * P2-A4: replace native `required` attribute with explicit inline
   * per-field errors (role="alert" + aria-invalid + aria-describedby).
   * Native `required` was the only validation guard; submit silently
   * dropped a request that would 100% fail on the backend with a less
   * clear error.
   */
  it("blocks submit and surfaces an inline alert when local path is empty", async () => {
    render(
      <ScpDialog
        open
        onOpenChange={vi.fn()}
        connection={{ id: "c1", name: "prod", host: "host", port: 22, type: "direct" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^upload$/i }));
    expect(invoke).not.toHaveBeenCalled();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/local path is required/i);
    expect(screen.getByLabelText(/local path/i)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("requires a remote path on download", async () => {
    const user = userEvent.setup();
    render(
      <ScpDialog
        open
        onOpenChange={vi.fn()}
        connection={{ id: "c1", name: "prod", host: "host", port: 22, type: "direct" }}
      />,
    );
    // Switch to download tab via real user interaction so Radix
    // actually fires onValueChange (jsdom + fireEvent.click skips it).
    await user.click(screen.getByRole("tab", { name: /download/i }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^download$/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText(/local path/i), {
      target: { value: "/tmp/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^download$/i }));
    expect(invoke).not.toHaveBeenCalled();
    const alerts = await screen.findAllByRole("alert");
    expect(
      alerts.some((a) =>
        /remote path is required for downloads/i.test(a.textContent ?? ""),
      ),
    ).toBe(true);
  });

  it("renders the submit error inside a role=alert with aria-live", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("permission denied");
    render(
      <ScpDialog
        open
        onOpenChange={vi.fn()}
        connection={{ id: "c1", name: "prod", host: "host", port: 22, type: "direct" }}
      />,
    );
    fireEvent.change(screen.getByLabelText(/local path/i), {
      target: { value: "/tmp/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^upload$/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/permission denied/i);
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  /*
   * Audit-3 P2#7: the recursive toggle was a hand-rolled native
   * <input type="checkbox"> with `accent-primary`, which renders a
   * different glyph on every OS, ignores theme tokens, and has no
   * consistent focus ring. It now goes through the shared <Checkbox>
   * primitive (Radix-backed). Pin the structural a11y contract:
   * role=checkbox, aria-checked toggling, label-via-wrapper still
   * binds the accessible name. NO native <input type=checkbox> should
   * remain in the dialog.
   */
  it("recursive toggle uses the shared Checkbox primitive (role=checkbox)", () => {
    render(
      <ScpDialog
        open
        onOpenChange={vi.fn()}
        connection={{ id: "c1", name: "prod", host: "host", port: 22, type: "direct" }}
      />,
    );
    const box = screen.getByRole("checkbox", {
      name: /transfer directories recursively/i,
    });
    expect(box).toHaveAttribute("aria-checked", "false");
    fireEvent.click(box);
    expect(box).toHaveAttribute("aria-checked", "true");
    // No native checkboxes should remain.
    const natives = document.querySelectorAll('input[type="checkbox"]');
    // Radix renders a hidden <input type="checkbox"> for form
    // participation, so we instead check that the box exposed to AT
    // is the Radix button (its tagName is BUTTON, not INPUT).
    expect(box.tagName).toBe("BUTTON");
    // Whatever native inputs Radix may render must be aria-hidden so
    // AT only sees the styled button.
    natives.forEach((n) => {
      expect(n).toHaveAttribute("aria-hidden", "true");
    });
  });
});
