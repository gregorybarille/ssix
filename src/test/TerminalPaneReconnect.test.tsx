import { useEffect } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FailedTerminal } from "@/components/FailedTerminal";
import { TerminalTabs, type TerminalSession } from "@/components/TerminalTabs";
import { invoke } from "@/lib/tauri";
import type { ReconnectState } from "@/lib/reconnect";
import type { Connection } from "@/types";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const mounts = vi.fn();
vi.mock("@/components/Terminal", () => ({
  Terminal: ({ sessionId }: { sessionId: string }) => {
    useEffect(() => {
      mounts(sessionId);
    }, []);
    return <div data-testid="terminal" data-session-id={sessionId} />;
  },
}));

const conn: Connection = {
  id: "c1",
  name: "web",
  host: "web.example",
  port: 22,
  type: "direct",
  tags: [],
};

const WAITING: ReconnectState = {
  phase: "waiting",
  attempt: 2,
  maxAttempts: 5,
  retryAt: 0,
  message: "SSH read error: gone",
};
const STOPPED: ReconnectState = { phase: "stopped", message: "Password auth failed: nope" };

beforeEach(() => {
  mounts.mockClear();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

function renderStatus(reconnect: ReconnectState, error?: string) {
  const props = { onRetry: vi.fn(), onEdit: vi.fn(), onClose: vi.fn(), onCancelReconnect: vi.fn() };
  render(
    <FailedTerminal
      connectionName="web"
      connection={conn}
      isVisible
      reconnect={reconnect}
      retrying={reconnect.phase === "waiting"}
      error={error}
      {...props}
    />,
  );
  return props;
}

describe("the status of a shell that lost its connection", () => {
  it("while waiting: says which attempt comes next and offers only Cancel", async () => {
    const { onCancelReconnect, onClose } = renderStatus(WAITING);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Connection to web lost");
    expect(status).toHaveTextContent("Reconnecting: attempt 2 of 5");
    expect(status).toHaveTextContent("SSH read error: gone");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("reconnect-cancel-button"));
    expect(onCancelReconnect).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("counts down each second without announcing it to screen readers", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      renderStatus({ ...WAITING, retryAt: 14_000 });
      const countdown = screen.getByTestId("reconnect-countdown");
      expect(countdown).toHaveTextContent("in 4 s");
      expect(countdown).toHaveAttribute("aria-hidden", "true");

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(countdown).toHaveTextContent("in 3 s");

      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(countdown).toHaveTextContent("…");
    } finally {
      vi.useRealTimers();
    }
  });

  it("once stopped: shows the reason and offers Retry, Edit and Close", async () => {
    const { onRetry, onClose } = renderStatus(STOPPED, STOPPED.message);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Connection to web lost");
    expect(alert).toHaveTextContent("Password auth failed: nope");
    expect(screen.queryByTestId("reconnect-cancel-button")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /edit connection/i })).toBeEnabled();

    await userEvent.click(screen.getByTestId("failed-terminal-retry"));
    expect(onRetry).toHaveBeenCalledWith(conn);
    await userEvent.click(screen.getByRole("button", { name: "Close terminal" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("once stopped on a changed host key: offers to trust it", async () => {
    const error =
      "HOST_KEY_MISMATCH host=web.example port=22 fingerprint=SHA256:abc\nThe key changed.";
    const { onRetry } = renderStatus({ phase: "stopped", message: error }, error);
    expect(screen.getByRole("alert")).toHaveTextContent("Host key for web.example:22 has changed");

    await userEvent.click(screen.getByTestId("trust-host-key-button"));
    expect(invokeMock).toHaveBeenCalledWith("ssh_forget_host_key", {
      host: "web.example",
      port: 22,
    });
    expect(onRetry).toHaveBeenCalledWith(conn);
  });

  it("marks its phase and attempt for the E2E suite", () => {
    renderStatus(WAITING);
    const view = screen.getByTestId("failed-terminal");
    expect(view).toHaveAttribute("data-reconnect-phase", "waiting");
    expect(view).toHaveAttribute("data-reconnect-attempt", "2");
  });

  it("leaves a first connection's failure as it was", () => {
    render(
      <FailedTerminal
        connectionName="web"
        connection={conn}
        isVisible
        error="refused"
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Could not connect to web");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.getByTestId("failed-terminal")).not.toHaveAttribute("data-reconnect-phase");
  });
});

describe("a pane's terminal", () => {
  function tabs(pane: Partial<TerminalSession>) {
    return (
      <TerminalTabs
        tabs={[
          {
            id: "t1",
            mode: "single",
            panes: [{ sessionId: "s1", connectionName: "web", connection: conn, ...pane }],
          },
        ]}
        activeTabId="t1"
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onClosePane={vi.fn()}
        onNewTab={vi.fn()}
        onRetry={vi.fn()}
        onEdit={vi.fn()}
      />
    );
  }

  it("stays mounted through a whole reconnect, so its scrollback survives", () => {
    const { rerender } = render(tabs({}));
    expect(screen.getByTestId("terminal")).toBeInTheDocument();
    expect(screen.queryByTestId("failed-terminal")).not.toBeInTheDocument();
    expect(mounts).toHaveBeenCalledTimes(1);

    rerender(tabs({ retrying: true, reconnect: WAITING }));
    expect(screen.getByTestId("terminal")).toBeInTheDocument();
    expect(screen.getByTestId("failed-terminal")).toBeInTheDocument();

    rerender(tabs({ error: STOPPED.message, reconnect: STOPPED }));
    expect(screen.getByTestId("terminal")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Password auth failed");

    rerender(tabs({}));
    expect(screen.getByTestId("terminal")).toBeInTheDocument();
    expect(screen.queryByTestId("failed-terminal")).not.toBeInTheDocument();
    expect(mounts).toHaveBeenCalledTimes(1);
  });

  it("does not exist before the first connection succeeded", () => {
    const { rerender } = render(tabs({ retrying: true }));
    expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
    expect(screen.getByTestId("failed-terminal")).toBeInTheDocument();

    rerender(tabs({ error: "refused" }));
    expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not connect to web");
  });

  it("cancels the reconnect of its own session", async () => {
    render(tabs({ retrying: true, reconnect: WAITING }));
    await userEvent.click(screen.getByTestId("reconnect-cancel-button"));
    expect(invokeMock).toHaveBeenCalledWith("ssh_cancel_reconnect", { sessionId: "s1" });
  });
});
