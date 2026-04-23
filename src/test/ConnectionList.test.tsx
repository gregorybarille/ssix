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

  it("shows badges for tunnel kinds", () => {
    render(
      <ConnectionList
        connections={mockConnections}
        credentials={mockCredentials}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
      />
    );
    expect(screen.getByText("port-forward")).toBeInTheDocument();
    expect(screen.getByText("jump-shell")).toBeInTheDocument();
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
    const connectButtons = screen.getAllByTitle("Connect");
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
    expect(screen.getAllByTitle("Transfer files")).toHaveLength(2);
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
    const connectButtons = screen.getAllByTitle("Connect");
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

  it("calls onConnect when Connect is clicked in tile layout without triggering onSelect", () => {
    const onConnect = vi.fn();
    const onSelect = vi.fn();
    render(
      <ConnectionList
        connections={[mockConnections[0]]}
        credentials={[]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        onConnect={onConnect}
        onSelect={onSelect}
        layout="tile"
      />
    );
    fireEvent.click(screen.getByTitle("Connect"));
    expect(onConnect).toHaveBeenCalledWith(mockConnections[0]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("calls onClone when Clone is clicked in tile layout without triggering onSelect", () => {
    const onClone = vi.fn();
    const onSelect = vi.fn();
    render(
      <ConnectionList
        connections={[mockConnections[0]]}
        credentials={[]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={onClone}
        onSelect={onSelect}
        layout="tile"
      />
    );
    fireEvent.click(screen.getByTitle("Clone connection"));
    expect(onClone).toHaveBeenCalledWith(mockConnections[0]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("calls onEdit when Edit is clicked in tile layout without triggering onSelect", () => {
    const onEdit = vi.fn();
    const onSelect = vi.fn();
    render(
      <ConnectionList
        connections={[mockConnections[0]]}
        credentials={[]}
        onEdit={onEdit}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        onSelect={onSelect}
        layout="tile"
      />
    );
    fireEvent.click(screen.getByTitle("Edit connection"));
    expect(onEdit).toHaveBeenCalledWith(mockConnections[0]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("calls onDelete when Delete is clicked in tile layout without triggering onSelect", () => {
    const onDelete = vi.fn();
    const onSelect = vi.fn();
    render(
      <ConnectionList
        connections={[mockConnections[0]]}
        credentials={[]}
        onEdit={vi.fn()}
        onDelete={onDelete}
        onClone={vi.fn()}
        onSelect={onSelect}
        layout="tile"
      />
    );
    fireEvent.click(screen.getByTitle("Delete connection"));
    expect(onDelete).toHaveBeenCalledWith(mockConnections[0].id);
    expect(onSelect).not.toHaveBeenCalled();
  });

  // ─── Always-visible Connect CTA (P0-8) ────────────────────────────────────

  it("renders Connect outside the hover-fade group in row layout", () => {
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
    const connectBtn = screen.getByTitle("Connect");
    const editBtn = screen.getByTitle("Edit connection");
    // Connect must NOT be a descendant of any element with the hover-fade class.
    expect(connectBtn.closest(".opacity-0")).toBeNull();
    // Secondary actions stay in the hover-fade group.
    expect(editBtn.closest(".opacity-0")).not.toBeNull();
  });

  it("renders Connect outside the hover-fade group in tile layout", () => {
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
    const connectBtn = screen.getByTitle("Connect");
    const editBtn = screen.getByTitle("Edit connection");
    expect(connectBtn.closest(".opacity-0")).toBeNull();
    expect(editBtn.closest(".opacity-0")).not.toBeNull();
  });
});
