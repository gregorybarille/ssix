import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TunnelsView, TunnelSession } from "@/components/TunnelsView";
import { Connection, Credential } from "@/types";

// Stub out TunnelTab so we don't need Tauri event APIs in tests.
// The stub still surfaces the inner "Stop tunnel" affordance bound
// to the wired-in `onDisconnect`, so we can assert that TunnelsView
// routes that callback through the same ConfirmDialog as the row's
// X button (Audit-3 P2#12).
vi.mock("@/components/TunnelTab", () => ({
  TunnelTab: ({
    sessionId,
    onDisconnect,
  }: {
    sessionId: string;
    onDisconnect: () => void;
  }) => (
    <div data-testid={`tunnel-tab-${sessionId}`}>
      <button type="button" onClick={onDisconnect}>
        Stop tunnel
      </button>
    </div>
  ),
}));

const portForwardConn: Connection = {
  id: "pf-1",
  name: "api-tunnel",
  host: "api.internal",
  port: 80,
  type: "port_forward",
  gateway_host: "gateway.dev",
  gateway_port: 22,
  gateway_credential_id: "gw-cred",
  local_port: 9000,
  destination_host: "api.internal",
  destination_port: 80,
};

const directConn: Connection = {
  id: "direct-1",
  name: "prod-server",
  host: "10.0.0.1",
  port: 22,
  type: "direct",
};

const mockConnections: Connection[] = [portForwardConn, directConn];
const mockCredentials: Credential[] = [];

const defaultProps = {
  sessions: [] as TunnelSession[],
  connections: mockConnections,
  credentials: mockCredentials,
  layout: "list" as const,
  onLayoutChange: vi.fn(),
  onCloseSession: vi.fn(),
  onConnect: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onClone: vi.fn(),
};

describe("TunnelsView", () => {
  it("renders the Tunnels heading", () => {
    render(<TunnelsView {...defaultProps} />);
    expect(screen.getByText("Tunnels")).toBeInTheDocument();
  });

  it("shows 'No tunnel is currently running' when there are no active sessions", () => {
    render(<TunnelsView {...defaultProps} sessions={[]} />);
    expect(
      screen.getByText("No tunnel is currently running."),
    ).toBeInTheDocument();
  });

  it("renders active session names", () => {
    const sessions: TunnelSession[] = [
      {
        sessionId: "s-1",
        connectionName: "api-tunnel",
        connection: portForwardConn,
      },
    ];
    render(<TunnelsView {...defaultProps} sessions={sessions} />);
    // The header of the session card shows the connection name
    expect(screen.getAllByText("api-tunnel").length).toBeGreaterThan(0);
  });

  it("opens a confirm dialog before disconnecting (Audit-2 #2) and only calls onCloseSession after confirmation", async () => {
    const user = userEvent.setup();
    const onCloseSession = vi.fn();
    const sessions: TunnelSession[] = [
      {
        sessionId: "s-42",
        connectionName: "api-tunnel",
        connection: portForwardConn,
      },
    ];
    render(
      <TunnelsView {...defaultProps} sessions={sessions} onCloseSession={onCloseSession} />,
    );

    // Audit-2 #1: the icon-only button must expose an aria-label that
    // identifies which tunnel it disconnects (title alone is unreliable
    // across AT and not announced on touch).
    const closeBtn = screen.getByRole("button", {
      name: "Disconnect tunnel api-tunnel",
    });
    await user.click(closeBtn);

    // The session must NOT be torn down on the first click — a
    // ConfirmDialog gates the destructive action.
    expect(onCloseSession).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: /disconnect tunnel\?/i }),
    ).toBeInTheDocument();

    // Confirm the action.
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(onCloseSession).toHaveBeenCalledWith("s-42");
  });

  it("does not disconnect when the user cancels the confirm dialog", async () => {
    const user = userEvent.setup();
    const onCloseSession = vi.fn();
    const sessions: TunnelSession[] = [
      {
        sessionId: "s-99",
        connectionName: "api-tunnel",
        connection: portForwardConn,
      },
    ];
    render(
      <TunnelsView {...defaultProps} sessions={sessions} onCloseSession={onCloseSession} />,
    );
    await user.click(
      screen.getByRole("button", { name: "Disconnect tunnel api-tunnel" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCloseSession).not.toHaveBeenCalled();
  });

  /*
   * Audit-3 P2#12: the inner "Stop tunnel" button inside <TunnelTab>
   * (the destructive button at the bottom of each session pane) MUST
   * also route through the same ConfirmDialog as the row's X button.
   * Both are destructive actions on a live session and AGENTS.md
   * contract requires them to be confirmed. Pin both code paths so a
   * future refactor that wires `onDisconnect` directly to the
   * dispatcher cannot regress this.
   */
  it("inner 'Stop tunnel' button also opens the confirm dialog (Audit-3 P2#12)", async () => {
    const user = userEvent.setup();
    const onCloseSession = vi.fn();
    const sessions: TunnelSession[] = [
      {
        sessionId: "s-stop",
        connectionName: "api-tunnel",
        connection: portForwardConn,
      },
    ];
    render(
      <TunnelsView {...defaultProps} sessions={sessions} onCloseSession={onCloseSession} />,
    );
    await user.click(screen.getByRole("button", { name: /^stop tunnel$/i }));
    // The confirm dialog must appear (NOT a direct disconnect).
    expect(
      screen.getByText(/Disconnecting "api-tunnel" will drop/i),
    ).toBeInTheDocument();
    expect(onCloseSession).not.toHaveBeenCalled();
    // Confirming proceeds.
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(onCloseSession).toHaveBeenCalledWith("s-stop");
  });

  it("filters tunnel definitions to port_forward connections only", () => {
    render(<TunnelsView {...defaultProps} />);
    // api-tunnel (port_forward) should appear in definitions section
    expect(screen.getByText("api-tunnel")).toBeInTheDocument();
    // prod-server (direct) should NOT appear
    expect(screen.queryByText("prod-server")).not.toBeInTheDocument();
  });

  it("passes layout to the LayoutToggle and calls onLayoutChange when toggled", () => {
    const onLayoutChange = vi.fn();
    render(
      <TunnelsView {...defaultProps} layout="list" onLayoutChange={onLayoutChange} />,
    );
    // The List button is aria-pressed="true" for layout="list"
    expect(screen.getByTitle("List")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTitle("Tiles"));
    expect(onLayoutChange).toHaveBeenCalledWith("tile");
  });

  it("shows Tunnel definitions count", () => {
    render(<TunnelsView {...defaultProps} />);
    expect(screen.getByText("Tunnel definitions (1)")).toBeInTheDocument();
  });
});
