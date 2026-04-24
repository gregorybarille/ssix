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
    // Audit-3 P2#8: success text now appears in two places — the
    // visible result <div> AND the sr-only role=status live region
    // (so AT actually announces it). Both should match.
    const matches = await screen.findAllByText(/Transferred 12 bytes/);
    expect(matches.length).toBeGreaterThanOrEqual(2);
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
    const natives = document.querySelectorAll('input[type="checkbox"]');
    expect(box.tagName).toBe("BUTTON");
    natives.forEach((n) => {
      expect(n).toHaveAttribute("aria-hidden", "true");
    });
  });

  /*
   * Audit-3 P2#8: the only visual progress signal was the submit
   * button's label flipping to 'Transferring...', and the only
   * success signal was a static <div>Transferred N bytes</div>
   * appearing after the await. Neither was announced to screen
   * readers — AT does not reliably re-announce a button's accessible
   * name change, and a non-live <div> being mounted is silent.
   * A role=status + aria-live=polite region (always mounted, so AT
   * is subscribed before content arrives) carries both messages.
   */
  it("announces transfer success via a polite status live region", async () => {
    vi.mocked(invoke).mockResolvedValue({
      local_path: "/tmp/file",
      remote_path: "/srv/app/file",
      bytes: 4096,
      entries: 1,
    });
    render(
      <ScpDialog
        open
        onOpenChange={vi.fn()}
        connection={{ id: "c1", name: "prod", host: "host", port: 22, type: "direct" }}
      />,
    );
    // Live region must exist on initial render (empty), so AT is
    // already subscribed when the message appears.
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(status.textContent).toBe("");

    fireEvent.change(screen.getByLabelText(/local path/i), {
      target: { value: "/tmp/file" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^upload$/i }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /transferred 4096 bytes/i,
      ),
    );
  });

  /*
   * Audit-3 follow-up P2#6 / helper-text association: the persistent
   * <p> describing remote-path semantics ("Uses the connection
   * remote path as the base directory…") must be wired to the
   * input via aria-describedby. Otherwise AT users tabbing into
   * the field hear only "Remote path, edit text" and miss the
   * directory-transfer hint. The hint id is always present; the
   * error id only joins it when there's a validation failure.
   */
  it("links the remote-path help text to the input via aria-describedby", () => {
    render(
      <ScpDialog
        open
        onOpenChange={vi.fn()}
        connection={{
          id: "c1",
          name: "prod",
          host: "host",
          port: 22,
          type: "direct",
          remote_path: "/srv/app",
        }}
      />
    );

    const input = screen.getByLabelText(/remote path/i) as HTMLInputElement;
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(describedBy.split(/\s+/)).toContain("scp-remote-path-hint");

    const hint = document.getElementById("scp-remote-path-hint");
    expect(hint?.textContent ?? "").toMatch(/base directory/i);
  });
});
