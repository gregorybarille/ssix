import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
