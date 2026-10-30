import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FailedTerminal } from "@/components/FailedTerminal";
import { Connection } from "@/types";
import { invoke } from "@/lib/tauri";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const MISMATCH =
  "HOST_KEY_MISMATCH host=10.0.0.1 port=22 fingerprint=SHA256:abc\n" +
  "The host key for 10.0.0.1:22 has changed. If you expect this change, trust the new key.";

const conn: Connection = {
  id: "c1",
  name: "prod",
  host: "10.0.0.1",
  port: 22,
  type: "direct",
};

describe("FailedTerminal", () => {
  /*
   * Audit-3 P3#15: connection failures must be announced to screen
   * readers. The whole status block (heading + backend's error
   * string) is wrapped in role=alert + aria-live=assertive when
   * `error` is set, so AT announces it as soon as the FailedTerminal
   * mounts or the error changes between retries.
   */
  it("error state exposes role=alert + aria-live=assertive", () => {
    render(
      <FailedTerminal
        connectionName="prod"
        error="connection refused"
        connection={conn}
        isVisible
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(alert.textContent).toMatch(/Could not connect to prod/);
    expect(alert.textContent).toMatch(/connection refused/);
  });

  /*
   * Connecting state must NOT be assertive — it's an in-progress
   * status, not an emergency. Use role=status + aria-live=polite so
   * AT informs the user without interrupting their current speech.
   */
  it("connecting state uses role=status + aria-live=polite", () => {
    render(
      <FailedTerminal
        connectionName="prod"
        connection={conn}
        isVisible
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status.textContent).toMatch(/Connecting to prod/);
  });

  it("AlertCircle decoration is aria-hidden", () => {
    const { container } = render(
      <FailedTerminal
        connectionName="prod"
        error="boom"
        connection={conn}
        isVisible
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // AlertCircle renders an SVG; it should be aria-hidden so AT
    // doesn't double-announce ("warning Could not connect to prod").
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });

  describe("host key mismatch", () => {
    beforeEach(() => {
      invokeMock.mockReset();
    });

    it("explains the mismatch and offers to trust the new key", () => {
      render(
        <FailedTerminal
          connectionName="prod"
          error={MISMATCH}
          connection={conn}
          isVisible
          onRetry={vi.fn()}
          onEdit={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      expect(screen.getByRole("alert").textContent).toMatch(/Host key for 10.0.0.1:22 has changed/);
      expect(screen.getByText("SHA256:abc")).toBeInTheDocument();
      // The raw marker line is not shown to the user…
      expect(screen.queryByText(/HOST_KEY_MISMATCH/)).not.toBeInTheDocument();
      // …but stays on the container for diagnostics.
      expect(screen.getByTestId("failed-terminal")).toHaveAttribute("data-error", MISMATCH);
      expect(screen.getByTestId("trust-host-key-button")).toBeEnabled();
    });

    it("forgets the old key then retries the connection", async () => {
      invokeMock.mockResolvedValue(true);
      const onRetry = vi.fn();
      render(
        <FailedTerminal
          connectionName="prod"
          error={MISMATCH}
          connection={conn}
          isVisible
          onRetry={onRetry}
          onEdit={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      await userEvent.click(screen.getByTestId("trust-host-key-button"));
      await waitFor(() => expect(onRetry).toHaveBeenCalledWith(conn));
      expect(invokeMock).toHaveBeenCalledWith("ssh_forget_host_key", { host: "10.0.0.1", port: 22 });
    });

    it("shows the backend error and does not retry when forgetting fails", async () => {
      invokeMock.mockRejectedValue("known_hosts is unreadable");
      const onRetry = vi.fn();
      render(
        <FailedTerminal
          connectionName="prod"
          error={MISMATCH}
          connection={conn}
          isVisible
          onRetry={onRetry}
          onEdit={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      await userEvent.click(screen.getByTestId("trust-host-key-button"));
      await screen.findByText("known_hosts is unreadable");
      expect(onRetry).not.toHaveBeenCalled();
    });

    it("has no trust button for ordinary failures", () => {
      render(
        <FailedTerminal
          connectionName="prod"
          error="connection refused"
          connection={conn}
          isVisible
          onRetry={vi.fn()}
          onEdit={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      expect(screen.queryByTestId("trust-host-key-button")).not.toBeInTheDocument();
    });
  });
});
