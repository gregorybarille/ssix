import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConnectionList } from "@/components/ConnectionList";
import { Connection, Credential } from "@/types";

const mockConnections: Connection[] = [
  { id: "1", name: "prod-server", host: "192.168.1.1", port: 22, type: "direct" },
  {
    id: "2",
    name: "tunnel-dev",
    host: "internal.dev",
    port: 22,
    type: "tunnel",
    gateway_host: "gateway.dev",
    gateway_port: 22,
    destination_host: "internal.dev",
    destination_port: 22,
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
    expect(screen.getByText("tunnel-dev")).toBeInTheDocument();
  });

  it("shows tunnel badge for tunnel connections", () => {
    render(
      <ConnectionList
        connections={mockConnections}
        credentials={mockCredentials}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
      />
    );
    expect(screen.getByText("tunnel")).toBeInTheDocument();
  });

  it("renders connect buttons only for direct connections when onConnect is provided", () => {
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
    // Only the direct connection gets a Connect button; tunnel connections do not
    const directCount = mockConnections.filter((c) => c.type === "direct").length;
    expect(connectButtons).toHaveLength(directCount);
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
});
