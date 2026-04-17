import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConnectPicker } from "@/components/ConnectPicker";
import { Connection, Credential } from "@/types";

const mockConnections: Connection[] = [
  { id: "c1", name: "prod-server", host: "10.0.0.1", port: 22, type: "direct" },
  { id: "c2", name: "staging-server", host: "10.0.0.2", port: 22, type: "direct", credential_id: "cred1" },
  {
    id: "c3",
    name: "tunnel-dev",
    host: "internal.dev",
    port: 22,
    type: "tunnel",
    gateway_host: "gw.dev",
    gateway_port: 22,
    destination_host: "internal.dev",
    destination_port: 22,
  },
];

const mockCredentials: Credential[] = [
  { id: "cred1", name: "staging-key", username: "deploy", type: "password", password: "secret" },
];

describe("ConnectPicker", () => {
  it("renders connection list when open", () => {
    render(
      <ConnectPicker
        open={true}
        onOpenChange={vi.fn()}
        connections={mockConnections}
        credentials={mockCredentials}
        onConnect={vi.fn()}
      />
    );
    expect(screen.getByText("Open Connection")).toBeInTheDocument();
    expect(screen.getByText("prod-server")).toBeInTheDocument();
    expect(screen.getByText("staging-server")).toBeInTheDocument();
    expect(screen.getByText("tunnel-dev")).toBeInTheDocument();
  });

  it("shows credential name for connections with credentials", () => {
    render(
      <ConnectPicker
        open={true}
        onOpenChange={vi.fn()}
        connections={mockConnections}
        credentials={mockCredentials}
        onConnect={vi.fn()}
      />
    );
    expect(screen.getByText(/staging-key/)).toBeInTheDocument();
  });

  it("calls onConnect when clicking a connection", () => {
    const onConnect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConnectPicker
        open={true}
        onOpenChange={onOpenChange}
        connections={mockConnections}
        credentials={mockCredentials}
        onConnect={onConnect}
      />
    );
    fireEvent.click(screen.getByText("prod-server"));
    expect(onConnect).toHaveBeenCalledWith(mockConnections[0]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows empty state when no connections", () => {
    render(
      <ConnectPicker
        open={true}
        onOpenChange={vi.fn()}
        connections={[]}
        credentials={[]}
        onConnect={vi.fn()}
      />
    );
    expect(screen.getByText("No connections configured yet.")).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    render(
      <ConnectPicker
        open={false}
        onOpenChange={vi.fn()}
        connections={mockConnections}
        credentials={mockCredentials}
        onConnect={vi.fn()}
      />
    );
    expect(screen.queryByText("Open Connection")).not.toBeInTheDocument();
  });
});
