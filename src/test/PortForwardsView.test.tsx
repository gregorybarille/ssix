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

const remoteForwardConn: ForwardSession["connection"] = {
  id: "rf-1",
  name: "webhook",
  host: "gateway.dev",
  port: 22,
  type: "remote_forward",
  gateway_host: "gateway.dev",
  gateway_port: 22,
  gateway_credential_id: "gw-cred",
  remote_port: 8080,
  destination_host: "127.0.0.1",
  destination_port: 3000,
};

const dynamicForwardConn: ForwardSession["connection"] = {
  id: "df-1",
  name: "socks",
  host: "gateway.dev",
  port: 22,
  type: "dynamic_forward",
  gateway_host: "gateway.dev",
  gateway_port: 22,
  gateway_credential_id: "gw-cred",
  local_port: 1080,
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

  it("names all three forward flags in the heading", () => {
    render(<PortForwardsView {...defaultProps} />);
    expect(screen.getByText("ssh -L -R -D")).toBeInTheDocument();
  });

  it("does not call the empty list local forwards", () => {
    render(<PortForwardsView {...defaultProps} connections={[]} />);
    expect(screen.getByText("No port forwards configured yet.")).toBeInTheDocument();
  });

  it("lists remote and dynamic forwards as rows", () => {
    render(
      <PortForwardsView
        {...defaultProps}
        connections={[remoteForwardConn, dynamicForwardConn]}
      />,
    );
    expect(screen.getByTestId("forward-row-rf-1")).toHaveAttribute("data-name", "webhook");
    expect(screen.getByTestId("forward-row-df-1")).toHaveAttribute("data-name", "socks");
    expect(screen.getByText("2 configured")).toBeInTheDocument();
  });

  it("says the connection was lost when a running forward ended, and offers a restart", () => {
    const sessions: ForwardSession[] = [
      {
        sessionId: "s-lost",
        connectionName: "api-tunnel",
        connection: portForwardConn,
        error: "Lost the connection to the SSH server gateway.dev:22",
        lost: true,
      },
    ];
    render(<PortForwardsView {...defaultProps} sessions={sessions} />);
    expect(screen.getByTestId("forward-row-pf-1")).toHaveAttribute("data-status", "error");
    expect(screen.getByTestId("forward-status-pf-1")).toHaveAccessibleName(
      "api-tunnel: Connection lost",
    );
    expect(screen.getByTestId("connect-button-pf-1")).toBeInTheDocument();
    expect(screen.queryByTestId("forward-stop-pf-1")).not.toBeInTheDocument();
  });

  it("shows the speed on a running forward's row, and the totals in its details", async () => {
    const user = userEvent.setup();
    const sessions: ForwardSession[] = [
      {
        sessionId: "s-busy",
        connectionName: "api-tunnel",
        connection: portForwardConn,
        activeClients: 1,
        bytesSent: 2048,
        bytesReceived: 3 * 1024 * 1024,
        sentPerSecond: 512,
        receivedPerSecond: 1536,
      },
    ];
    render(<PortForwardsView {...defaultProps} sessions={sessions} />);
    const row = screen.getByTestId("forward-row-pf-1");
    expect(row).toHaveAttribute("data-bytes-sent", "2048");
    expect(row).toHaveAttribute("data-bytes-received", String(3 * 1024 * 1024));
    expect(screen.getByTestId("forward-speed-pf-1")).toHaveTextContent(
      "Up 512 B/s, down 1.5 KB/s",
    );
    await user.click(within(row).getAllByRole("button")[0]);
    expect(screen.getByTestId("forward-uploaded-pf-1")).toHaveTextContent("2.0 KB");
    expect(screen.getByTestId("forward-downloaded-pf-1")).toHaveTextContent("3.0 MB");
  });

  it("shows no speed on a forward that is not running, and zero before any traffic", () => {
    const { rerender } = render(<PortForwardsView {...defaultProps} />);
    expect(screen.queryByTestId("forward-speed-pf-1")).not.toBeInTheDocument();
    rerender(
      <PortForwardsView
        {...defaultProps}
        sessions={[{ sessionId: "s", connectionName: "api-tunnel", connection: portForwardConn }]}
      />,
    );
    expect(screen.getByTestId("forward-speed-pf-1")).toHaveTextContent("Up 0 B/s, down 0 B/s");
  });

  it("shows where a forward listens, on the row and in its details", async () => {
    const user = userEvent.setup();
    const onLan = { ...dynamicForwardConn, bind_address: "10.0.0.5" } as ForwardSession["connection"];
    render(
      <PortForwardsView
        {...defaultProps}
        connections={[onLan, portForwardConn, remoteForwardConn]}
      />,
    );
    expect(screen.getByTestId("forward-row-df-1")).toHaveTextContent("10.0.0.5:1080 (SOCKS)");
    await user.click(within(screen.getByTestId("forward-row-df-1")).getAllByRole("button")[0]);
    expect(screen.getByTestId("forward-listen-address-df-1")).toHaveTextContent("10.0.0.5");
    await user.click(within(screen.getByTestId("forward-row-pf-1")).getAllByRole("button")[0]);
    expect(screen.getByTestId("forward-listen-address-pf-1")).toHaveTextContent("127.0.0.1");
    await user.click(within(screen.getByTestId("forward-row-rf-1")).getAllByRole("button")[0]);
    expect(screen.queryByTestId("forward-listen-address-rf-1")).not.toBeInTheDocument();
  });

  it("shows the client count and the last client error of a running forward", async () => {
    const user = userEvent.setup();
    const sessions: ForwardSession[] = [
      {
        sessionId: "s-busy",
        connectionName: "socks",
        connection: dynamicForwardConn,
        activeClients: 3,
        clientError: "to db:5432: connect failed",
      },
    ];
    render(
      <PortForwardsView {...defaultProps} connections={[dynamicForwardConn]} sessions={sessions} />,
    );
    const row = screen.getByTestId("forward-row-df-1");
    expect(row).toHaveAttribute("data-clients", "3");
    expect(row).toHaveAttribute("data-status", "connected");

    await user.click(within(row).getAllByRole("button")[0]);
    expect(screen.getByText("Clients")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Last client error")).toBeInTheDocument();
    expect(screen.getByText("to db:5432: connect failed")).toBeInTheDocument();
  });

  it("counts no clients on a forward that is not running", async () => {
    const user = userEvent.setup();
    render(<PortForwardsView {...defaultProps} />);
    const row = screen.getByTestId("forward-row-pf-1");
    expect(row).toHaveAttribute("data-clients", "0");
    await user.click(within(row).getAllByRole("button")[0]);
    expect(screen.queryByText("Clients")).not.toBeInTheDocument();
  });

  it.each([
    { conn: portForwardConn as ForwardSession["connection"], label: "Local port", port: "9000" },
    { conn: remoteForwardConn, label: "Remote port", port: "8080" },
    { conn: dynamicForwardConn, label: "SOCKS port", port: "1080" },
  ])("labels the port it listens on as $label", async ({ conn, label, port }) => {
    const user = userEvent.setup();
    render(<PortForwardsView {...defaultProps} connections={[conn]} />);
    await user.click(
      within(screen.getByTestId(`forward-row-${conn.id}`)).getAllByRole("button")[0],
    );
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(port)).toBeInTheDocument();
  });

  it.each([
    { conn: portForwardConn as ForwardSession["connection"], consequence: "closes its local port" },
    { conn: remoteForwardConn, consequence: "closes its port on the SSH server" },
    { conn: dynamicForwardConn, consequence: "closes its SOCKS port" },
  ])("says stopping $consequence", async ({ conn, consequence }) => {
    const user = userEvent.setup();
    const sessions: ForwardSession[] = [
      { sessionId: "s-stop", connectionName: conn.name, connection: conn },
    ];
    render(<PortForwardsView {...defaultProps} connections={[conn]} sessions={sessions} />);
    await user.click(screen.getByTestId(`forward-stop-${conn.id}`));
    expect(screen.getByTestId("confirm-stop-forward")).toHaveTextContent(consequence);
    expect(screen.getByTestId("confirm-stop-forward")).toHaveTextContent(conn.name);
  });

  describe("confirming a stop opened while the forward was connecting", () => {
    const connecting: ForwardSession = {
      sessionId: "forward-pf-1-placeholder",
      connectionName: "api-tunnel",
      connection: portForwardConn as ForwardSession["connection"],
      retrying: true,
    };

    const openStop = async () => {
      const onCloseSession = vi.fn();
      const props = { ...defaultProps, onCloseSession };
      const user = userEvent.setup();
      const view = render(<PortForwardsView {...props} sessions={[connecting]} />);
      await user.click(screen.getByTestId("forward-stop-pf-1"));
      return {
        onCloseSession,
        becomes: (sessions: ForwardSession[]) =>
          view.rerender(<PortForwardsView {...props} sessions={sessions} />),
        confirm: () => user.click(screen.getByRole("button", { name: "Stop" })),
      };
    };

    it("stops the session it has connected as since", async () => {
      const { onCloseSession, becomes, confirm } = await openStop();
      becomes([{ ...connecting, sessionId: "session-real", retrying: false }]);
      await confirm();
      expect(onCloseSession).toHaveBeenCalledTimes(1);
      expect(onCloseSession).toHaveBeenCalledWith("session-real");
    });

    it("stops nothing if it has ended since", async () => {
      const { onCloseSession, becomes, confirm } = await openStop();
      becomes([]);
      await confirm();
      expect(onCloseSession).not.toHaveBeenCalled();
    });

    it("stops nothing if it has failed since", async () => {
      const { onCloseSession, becomes, confirm } = await openStop();
      becomes([{ ...connecting, retrying: false, error: "refused" }]);
      await confirm();
      expect(onCloseSession).not.toHaveBeenCalled();
    });
  });

  it("shows the configured forward count", () => {
    render(<PortForwardsView {...defaultProps} />);
    expect(screen.getByText(/1 configured/i)).toBeInTheDocument();
  });
});
