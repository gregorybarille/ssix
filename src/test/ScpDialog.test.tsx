import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScpDialog } from "@/components/ScpDialog";
import { invoke } from "@/lib/tauri";
import { useDialogsStore } from "@/store/useDialogsStore";

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

describe("ScpDialog Stop", () => {
  const prod = { id: "c1", name: "prod", host: "host", port: 22, type: "direct" } as const;
  let finish: (result: unknown) => void = () => {};

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(((command: string) =>
      command === "scp_stop"
        ? Promise.resolve()
        : new Promise((resolve) => {
            finish = resolve as (result: unknown) => void;
          })) as typeof invoke);
  });

  // React holds every other action back while one is pending, so none may hang.
  afterEach(async () => {
    finish({ local_path: "/l", remote_path: "/r", bytes: 0 });
    await waitFor(() => expect(screen.queryByTestId("scp-stop")).toBeNull());
    vi.mocked(invoke).mockReset();
  });

  async function startUpload(onOpenChange = vi.fn()) {
    render(<ScpDialog open onOpenChange={onOpenChange} connection={prod} />);
    expect(screen.queryByTestId("scp-stop")).toBeNull();
    fireEvent.change(screen.getByTestId("scp-local-path"), { target: { value: "/tmp/big" } });
    fireEvent.click(screen.getByTestId("scp-upload"));
    return screen.findByTestId("scp-stop");
  }

  it("asks the backend to stop, shows it is stopping, and ends on a neutral status", async () => {
    const stop = await startUpload();
    expect(stop).toBeEnabled();
    expect(stop).toHaveTextContent("Stop");

    fireEvent.click(stop);
    expect(invoke).toHaveBeenCalledWith("scp_stop", { connectionId: "c1" });
    await waitFor(() => expect(screen.getByTestId("scp-stop")).toBeDisabled());
    expect(screen.getByTestId("scp-stop")).toHaveTextContent("Stopping...");
    const live = screen.getByText(/Stopping the transfer/);
    expect(live).toHaveAttribute("aria-live", "polite");

    const message = "Transfer stopped after 5 bytes.";
    finish({ local_path: "/tmp/big", remote_path: "/tmp/big", bytes: 5, entries: 0, stopped: message });

    expect(await screen.findByTestId("scp-status")).toHaveTextContent(message);
    expect(screen.queryByTestId("scp-error")).toBeNull();
    expect(screen.queryByTestId("scp-stop")).toBeNull();
    // The always-mounted region was subscribed before the words arrived.
    expect(live).toHaveTextContent(message);
    expect(screen.queryByText(/^Transferred/)).toBeNull();
  });

  it("gives the button back if the stop is refused", async () => {
    vi.mocked(invoke).mockImplementation(((command: string) =>
      command === "scp_stop"
        ? Promise.reject("no")
        : new Promise((resolve) => {
            finish = resolve as (result: unknown) => void;
          })) as typeof invoke);
    fireEvent.click(await startUpload());
    await waitFor(() => expect(screen.getByTestId("scp-stop")).toBeEnabled());
  });

  it("leaves Stop as the only way out while running", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    await startUpload(onOpenChange);
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText("Close", { selector: "button" })).toBeDisabled();
  });

  it("starts the next transfer with the button ready again", async () => {
    fireEvent.click(await startUpload());
    await waitFor(() => expect(screen.getByTestId("scp-stop")).toBeDisabled());
    finish({ local_path: "/l", remote_path: "/r", bytes: 0, entries: 0, stopped: "Transfer stopped." });
    await screen.findByTestId("scp-status");

    fireEvent.click(screen.getByTestId("scp-upload"));
    await waitFor(() => expect(screen.getByTestId("scp-stop")).toBeEnabled());
  });
});

describe("ScpDialog result scoping", () => {
  it("does not show a previous connection's result when reopened for another", async () => {
    const { invoke } = await import("@/lib/tauri");
    vi.mocked(invoke).mockResolvedValueOnce({
      bytes: 3,
      entries: 1,
      local_path: "/tmp/up.txt",
      remote_path: "/srv/up.txt",
    });
    const connA = { id: "a", name: "alpha", host: "a", port: 22, type: "direct" } as const;
    const connB = { id: "b", name: "beta", host: "b", port: 22, type: "direct" } as const;
    const { rerender } = render(<ScpDialog open onOpenChange={vi.fn()} connection={connA} />);
    fireEvent.change(screen.getByTestId("scp-local-path"), { target: { value: "/tmp/up.txt" } });
    fireEvent.click(screen.getByTestId("scp-upload"));
    await screen.findByTestId("scp-status");

    // Close, then open for a different connection: the dialog stays mounted
    // at the App root, so the old result must not leak through.
    rerender(<ScpDialog open={false} onOpenChange={vi.fn()} connection={connA} />);
    rerender(<ScpDialog open onOpenChange={vi.fn()} connection={connB} />);
    await waitFor(() => expect(screen.queryByTestId("scp-status")).toBeNull());
  });

  it("stays open on Escape until the transfer ends, so its outcome is shown", async () => {
    const user = userEvent.setup();
    const { invoke } = await import("@/lib/tauri");
    let fail = (_reason: string) => {};
    vi.mocked(invoke).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    const onOpenChange = vi.fn();
    render(
      <ScpDialog
        open
        onOpenChange={onOpenChange}
        connection={{ id: "c1", name: "prod", host: "host", port: 22, type: "direct" }}
      />,
    );
    fireEvent.change(screen.getByTestId("scp-local-path"), { target: { value: "/tmp/up.txt" } });
    fireEvent.click(screen.getByTestId("scp-upload"));
    await waitFor(() => expect(screen.getByTestId("scp-upload")).toBeDisabled());

    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();

    fail("disk full");
    expect(await screen.findByTestId("scp-error")).toHaveTextContent("disk full");
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps its target until the transfer ends, so its outcome is shown", async () => {
    let finish = (_result: unknown) => {};
    vi.mocked(invoke).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const connection = (id: string, name: string) =>
      ({ id, name, host: "host", port: 22, type: "direct" }) as never;
    const Bound = () => {
      const open = useDialogsStore((s) => s.scpOpen);
      const target = useDialogsStore((s) => s.scpConnection);
      return <ScpDialog open={open} onOpenChange={vi.fn()} connection={target} />;
    };
    useDialogsStore.getState().openScp(connection("c1", "prod"));
    render(<Bound />);
    fireEvent.change(screen.getByTestId("scp-local-path"), { target: { value: "/tmp/up.txt" } });
    fireEvent.click(screen.getByTestId("scp-upload"));
    await waitFor(() => expect(screen.getByTestId("scp-upload")).toBeDisabled());

    useDialogsStore.getState().openScp(connection("c2", "staging"));
    useDialogsStore.getState().openBulkScp("group", [connection("c2", "staging")]);
    expect(useDialogsStore.getState().scpConnection?.id).toBe("c1");
    expect(useDialogsStore.getState().bulkScpOpen).toBe(false);

    finish({ local_path: "/tmp/up.txt", remote_path: "/srv/up.txt", bytes: 12, entries: 1 });
    expect(await screen.findByTestId("scp-status")).toHaveTextContent("Transferred 12 bytes");

    useDialogsStore.getState().openScp(connection("c2", "staging"));
    expect(useDialogsStore.getState().scpConnection?.id).toBe("c2");
  });

  it("hides the previous transfer's status once the mode changes", async () => {
    const user = userEvent.setup();
    const { invoke } = await import("@/lib/tauri");
    vi.mocked(invoke).mockResolvedValueOnce({
      bytes: 3,
      entries: 1,
      local_path: "/tmp/up.txt",
      remote_path: "/srv/up.txt",
    });
    render(
      <ScpDialog
        open
        onOpenChange={vi.fn()}
        connection={{ id: "c1", name: "prod", host: "host", port: 22, type: "direct" }}
      />,
    );
    fireEvent.change(screen.getByTestId("scp-local-path"), { target: { value: "/tmp/up.txt" } });
    fireEvent.click(screen.getByTestId("scp-upload"));
    await screen.findByTestId("scp-status");
    await user.click(screen.getByTestId("scp-mode-download"));
    await waitFor(() => expect(screen.queryByTestId("scp-status")).toBeNull());
  });
});
