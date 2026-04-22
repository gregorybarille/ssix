import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TunnelsView, TunnelSession } from "@/components/TunnelsView";
import { Connection, Credential } from "@/types";

// Stub out TunnelTab so we don't need Tauri event APIs in tests
vi.mock("@/components/TunnelTab", () => ({
  TunnelTab: ({ sessionId }: { sessionId: string }) => (
    <div data-testid={`tunnel-tab-${sessionId}`} />
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

  it("calls onCloseSession when the Disconnect button is clicked", () => {
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
    fireEvent.click(screen.getByTitle("Disconnect tunnel"));
    expect(onCloseSession).toHaveBeenCalledWith("s-42");
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
