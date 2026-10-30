import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PortForwardsView, ForwardSession } from "@/components/PortForwardsView";
import { Connection, Credential } from "@/types";

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
  sessions: [] as ForwardSession[],
  connections: mockConnections,
  credentials: mockCredentials,
  onCloseSession: vi.fn(),
  onConnect: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onClone: vi.fn(),
};

describe("PortForwardsView", () => {
  it("renders the Port forwards heading", () => {
    render(<PortForwardsView {...defaultProps} />);
    expect(screen.getByText("Port forwards")).toBeInTheDocument();
  });

  it("renders every local forward as a status row", () => {
    render(<PortForwardsView {...defaultProps} sessions={[]} />);
    const row = screen.getByTestId("forward-row-pf-1");
    expect(row).toHaveAttribute("data-status", "disconnected");
    expect(screen.getByTestId("forward-status-pf-1")).toHaveAccessibleName(
      "api-tunnel: Not connected",
    );
  });

  it("renders active session names", () => {
    const sessions: ForwardSession[] = [
      {
        sessionId: "s-1",
        connectionName: "api-tunnel",
        connection: portForwardConn,
      },
    ];
    render(<PortForwardsView {...defaultProps} sessions={sessions} />);
    // The header of the session card shows the connection name
    expect(screen.getAllByText("api-tunnel").length).toBeGreaterThan(0);
  });

  it("opens a confirm dialog before stopping (Audit-2 #2) and only calls onCloseSession after confirmation", async () => {
    const user = userEvent.setup();
    const onCloseSession = vi.fn();
    const sessions: ForwardSession[] = [
      {
        sessionId: "s-42",
        connectionName: "api-tunnel",
        connection: portForwardConn,
      },
    ];
    render(
      <PortForwardsView {...defaultProps} sessions={sessions} onCloseSession={onCloseSession} />,
    );

    // Audit-2 #1: the icon-only button must expose an aria-label that
    // identifies which tunnel it disconnects (title alone is unreliable
    // across AT and not announced on touch).
    const closeBtn = screen.getByRole("button", {
      name: "Stop forward api-tunnel",
    });
    await user.click(closeBtn);

    // The session must NOT be torn down on the first click — a
    // ConfirmDialog gates the destructive action.
    expect(onCloseSession).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: /stop forwarding\?/i }),
    ).toBeInTheDocument();

    // Confirm the action.
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onCloseSession).toHaveBeenCalledWith("s-42");
  });

  it("does not stop when the user cancels the confirm dialog", async () => {
    const user = userEvent.setup();
    const onCloseSession = vi.fn();
    const sessions: ForwardSession[] = [
      {
        sessionId: "s-99",
        connectionName: "api-tunnel",
        connection: portForwardConn,
      },
    ];
    render(
      <PortForwardsView {...defaultProps} sessions={sessions} onCloseSession={onCloseSession} />,
    );
    await user.click(
      screen.getByRole("button", { name: "Stop forward api-tunnel" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCloseSession).not.toHaveBeenCalled();
  });

  it("shows red error status for failed forwards", () => {
    const sessions: ForwardSession[] = [
      {
        sessionId: "failed",
        connectionName: "api-tunnel",
        connection: portForwardConn,
        error: "Connection refused",
      },
    ];
    render(<PortForwardsView {...defaultProps} sessions={sessions} />);
    expect(screen.getByTestId("forward-row-pf-1")).toHaveAttribute(
      "data-status",
      "error",
    );
    expect(screen.getByTestId("forward-status-pf-1")).toHaveAccessibleName(
      "api-tunnel: Error connecting",
    );
  });

  it("expands details beneath the row and allows multiple rows to stay expanded", async () => {
    const user = userEvent.setup();
    const secondTunnel: Connection = {
      ...portForwardConn,
      id: "pf-2",
      name: "db-tunnel",
      local_port: 15432,
      destination_host: "db.internal",
      destination_port: 5432,
    };
    render(
      <PortForwardsView
        {...defaultProps}
        connections={[portForwardConn, secondTunnel]}
      />,
    );
    await user.click(within(screen.getByTestId("forward-row-pf-1")).getAllByRole("button")[0]);
    await user.click(within(screen.getByTestId("forward-row-pf-2")).getAllByRole("button")[0]);
    expect(screen.getAllByText("gateway.dev:22")).toHaveLength(2);
    expect(screen.getByText("db.internal:5432")).toBeInTheDocument();
  });

  it("lists only port_forward connections", () => {
    render(<PortForwardsView {...defaultProps} />);
    // api-tunnel (port_forward) should appear in definitions section
    expect(screen.getByText("api-tunnel")).toBeInTheDocument();
    // prod-server (direct) should NOT appear
    expect(screen.queryByText("prod-server")).not.toBeInTheDocument();
  });

  it("shows the configured forward count", () => {
    render(<PortForwardsView {...defaultProps} />);
    expect(screen.getByText(/1 configured/i)).toBeInTheDocument();
  });
});
