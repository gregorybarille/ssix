import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TunnelTab } from "@/components/TunnelTab";
import { Connection } from "@/types";

const portForwardConn: Connection = {
  id: "pf-1",
  name: "api-tunnel",
  host: "api.internal",
  port: 80,
  type: "port_forward",
  gateway_host: "gateway.example",
  gateway_port: 22,
  gateway_credential_id: "gw-cred",
  local_port: 9000,
  destination_host: "api.internal",
  destination_port: 80,
};

describe("TunnelTab", () => {
  it("renders the connection name and forwarding chain", () => {
    render(
      <TunnelTab
        sessionId="s-12345678"
        connection={portForwardConn}
        isVisible={true}
        onDisconnect={vi.fn()}
      />,
    );
    expect(screen.getByText("api-tunnel")).toBeInTheDocument();
    expect(screen.getByText("127.0.0.1:9000")).toBeInTheDocument();
    expect(screen.getByText("gateway.example:22")).toBeInTheDocument();
    expect(screen.getByText("api.internal:80")).toBeInTheDocument();
  });

  it("starts with zero active clients", () => {
    render(
      <TunnelTab
        sessionId="s-1"
        connection={portForwardConn}
        isVisible={true}
        onDisconnect={vi.fn()}
      />,
    );
    expect(screen.getByText("0 active clients")).toBeInTheDocument();
  });

  it("calls onDisconnect when Stop tunnel is clicked", () => {
    const onDisconnect = vi.fn();
    render(
      <TunnelTab
        sessionId="s-1"
        connection={portForwardConn}
        isVisible={true}
        onDisconnect={onDisconnect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /stop tunnel/i }));
    expect(onDisconnect).toHaveBeenCalled();
  });

  it("hides itself when not visible", () => {
    const { container } = render(
      <TunnelTab
        sessionId="s-1"
        connection={portForwardConn}
        isVisible={false}
        onDisconnect={vi.fn()}
      />,
    );
    expect(container.firstChild).toHaveClass("hidden");
  });
});
