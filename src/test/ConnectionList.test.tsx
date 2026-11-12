import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConnectionList } from "@/components/ConnectionList";
import { Connection, Credential } from "@/types";

const mockConnections: Connection[] = [
  { id: "1", name: "prod-server", host: "192.168.1.1", port: 22, type: "direct" },
  {
    id: "2",
    name: "jump-dev",
    host: "internal.dev",
    port: 22,
    type: "jump_shell",
    gateway_host: "gateway.dev",
    gateway_port: 22,
    gateway_credential_id: "gw-cred",
    destination_host: "internal.dev",
    destination_port: 22,
  },
  {
    id: "3",
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
  },
];

const mockCredentials: Credential[] = [];

describe("ConnectionList", () => {
  it("renders empty state when no connections", () => {
    render(
      <ConnectionList
        connections={[]}
        credentials={[]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
      />
    );
    expect(screen.getByText("No connections yet")).toBeInTheDocument();
  });

  it("renders connections", () => {
    render(
      <ConnectionList
        connections={mockConnections}
        credentials={mockCredentials}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
      />
    );
    expect(screen.getByText("prod-server")).toBeInTheDocument();
    expect(screen.getByText("jump-dev")).toBeInTheDocument();
    expect(screen.getByText("api-tunnel")).toBeInTheDocument();
  });

  it("shows badges for the two-hop kinds", () => {
    render(
      <ConnectionList
        connections={mockConnections}
        credentials={mockCredentials}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
      />
    );
    expect(screen.getByText("local forward")).toBeInTheDocument();
    expect(screen.getByText("jump host")).toBeInTheDocument();
  });

  it("refuses SCP on every forward kind, naming forwards in general", () => {
    const remoteForward: Connection = {
      id: "4",
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
    const dynamicForward: Connection = {
      id: "5",
      name: "socks",
      host: "gateway.dev",
      port: 22,
      type: "dynamic_forward",
      gateway_host: "gateway.dev",
      gateway_port: 22,
      gateway_credential_id: "gw-cred",
      local_port: 1080,
    };
    render(
      <ConnectionList
        connections={[remoteForward, dynamicForward]}
        credentials={mockCredentials}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        onScp={vi.fn()}
      />
    );
    const buttons = screen.getAllByRole("button", { name: "SCP not available for port forwards" });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button).toBeDisabled();
  });

  it("renders connect buttons for every connection kind when onConnect is provided", () => {
    render(
      <ConnectionList
        connections={mockConnections}
        credentials={mockCredentials}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        onConnect={vi.fn()}
      />
    );
    const connectButtons = screen.getAllByRole("button", { name: /^Connect to / });
    expect(connectButtons).toHaveLength(mockConnections.length);
  });

  it("renders transfer buttons only for shell-capable connections", () => {
    render(
      <ConnectionList
        connections={mockConnections}
        credentials={mockCredentials}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        onScp={vi.fn()}
      />
    );
    expect(screen.getAllByRole("button", { name: /^Transfer files to / })).toHaveLength(2);
  });

  it("calls onConnect with the correct connection", () => {
    const onConnect = vi.fn();
    render(
      <ConnectionList
        connections={mockConnections}
        credentials={mockCredentials}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        onConnect={onConnect}
      />
    );
    const connectButtons = screen.getAllByRole("button", { name: /^Connect to / });
    fireEvent.click(connectButtons[0]);
    expect(onConnect).toHaveBeenCalledWith(mockConnections[0]);
  });

  it("does not render connect buttons when onConnect is not provided", () => {
    render(
      <ConnectionList
        connections={mockConnections}
        credentials={mockCredentials}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
      />
    );
    expect(screen.queryByTitle("Connect")).not.toBeInTheDocument();
  });

  // ─── Tile layout ──────────────────────────────────────────────────────────

  it("renders a grid container in tile layout", () => {
    render(
      <ConnectionList
        connections={mockConnections}
        credentials={mockCredentials}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        layout="tile"
      />
    );
    expect(screen.getByTestId("connection-grid")).toBeInTheDocument();
  });

  it("renders connection names in tile layout", () => {
    render(
      <ConnectionList
        connections={mockConnections}
        credentials={mockCredentials}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        layout="tile"
      />
    );
    expect(screen.getByText("prod-server")).toBeInTheDocument();
    expect(screen.getByText("jump-dev")).toBeInTheDocument();
    expect(screen.getByText("api-tunnel")).toBeInTheDocument();
  });

  it("renders tags for tagged connections in tile layout", () => {
    const taggedConn: Connection = {
      id: "tagged",
      name: "tagged-server",
      host: "10.0.0.1",
      port: 22,
      type: "direct",
      tags: ["production", "k8s"],
    };
    render(
      <ConnectionList
        connections={[taggedConn]}
        credentials={[]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        layout="tile"
      />
    );
    expect(screen.getByText("production")).toBeInTheDocument();
    expect(screen.getByText("k8s")).toBeInTheDocument();
  });

  it("connects once when Connect is clicked in tile layout, not again for the row", () => {
    const onConnect = vi.fn();
    render(
      <ConnectionList
        connections={[mockConnections[0]]}
        credentials={[]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        onConnect={onConnect}
        layout="tile"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Connect to / }));
    expect(onConnect).toHaveBeenCalledExactlyOnceWith(mockConnections[0]);
  });

  it("calls onClone when Clone is clicked in tile layout without connecting", () => {
    const onClone = vi.fn();
    const onConnect = vi.fn();
    render(
      <ConnectionList
        connections={[mockConnections[0]]}
        credentials={[]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={onClone}
        onConnect={onConnect}
        layout="tile"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Clone / }));
    expect(onClone).toHaveBeenCalledWith(mockConnections[0]);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("calls onEdit when Edit is clicked in tile layout without connecting", () => {
    const onEdit = vi.fn();
    const onConnect = vi.fn();
    render(
      <ConnectionList
        connections={[mockConnections[0]]}
        credentials={[]}
        onEdit={onEdit}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        onConnect={onConnect}
        layout="tile"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Edit / }));
    expect(onEdit).toHaveBeenCalledWith(mockConnections[0]);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("calls onDelete when Delete is clicked in tile layout without connecting", () => {
    const onDelete = vi.fn();
    const onConnect = vi.fn();
    render(
      <ConnectionList
        connections={[mockConnections[0]]}
        credentials={[]}
        onEdit={vi.fn()}
        onDelete={onDelete}
        onClone={vi.fn()}
        onConnect={onConnect}
        layout="tile"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Delete / }));
    expect(onDelete).toHaveBeenCalledWith(mockConnections[0].id);
    expect(onConnect).not.toHaveBeenCalled();
  });

  // ─── Always-visible action cluster ────────────────────────────────────────
  // Per the v2 redesign, secondary row actions (SCP, Clone, Edit, Delete)
  // are no longer hover-revealed — keeping them visible at all times tells
  // the user up-front what is available without requiring discovery.

  it("renders all row actions visible (no hover-fade) in row layout", () => {
    render(
      <ConnectionList
        connections={[mockConnections[0]]}
        credentials={[]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        onConnect={vi.fn()}
      />
    );
    const connectBtn = screen.getByRole("button", { name: /^Connect to / });
    const editBtn = screen.getByRole("button", { name: /^Edit / });
    // Neither primary nor secondary actions sit inside an opacity-0 wrapper.
    expect(connectBtn.closest(".opacity-0")).toBeNull();
    expect(editBtn.closest(".opacity-0")).toBeNull();
  });

  it("renders all row actions visible (no hover-fade) in tile layout", () => {
    render(
      <ConnectionList
        connections={[mockConnections[0]]}
        credentials={[]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        onConnect={vi.fn()}
        layout="tile"
      />
    );
    const connectBtn = screen.getByRole("button", { name: /^Connect to / });
    const editBtn = screen.getByRole("button", { name: /^Edit / });
    expect(connectBtn.closest(".opacity-0")).toBeNull();
    expect(editBtn.closest(".opacity-0")).toBeNull();
  });
});
