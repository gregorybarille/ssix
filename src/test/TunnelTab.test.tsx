import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { TunnelTab, TunnelStatusPayload } from "@/components/TunnelTab";
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

/*
 * Audit-2 #3 coverage: TunnelTab must announce status and error
 * transitions to assistive technology. Status changes (active client
 * count) live in role="status" aria-live="polite"; errors live in
 * role="alert" aria-live="assertive".
 */
describe("TunnelTab a11y live regions (Audit-2 #3)", () => {
  it("renders the active-client count inside a polite status live region from first paint", () => {
    render(
      <TunnelTab
        sessionId="s-a11y-1"
        connection={portForwardConn}
        isVisible
        onDisconnect={() => {}}
      />,
    );
    const status = screen.getByRole("status");
    // The region must be polite (not assertive) so it doesn't interrupt
    // ongoing AT speech for routine connection churn.
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("0 active clients");
  });

  it("updates the polite status text when a tunnel-status event raises the active-client count", async () => {
    // Capture the listener registered by the component so we can fire
    // a payload at it from the test.
    let handler: ((event: { payload: TunnelStatusPayload }) => void) | null = null;
    vi.mocked(listen).mockImplementationOnce(async (_name, cb) => {
      handler = cb as typeof handler;
      return () => {};
    });

    render(
      <TunnelTab
        sessionId="s-a11y-2"
        connection={portForwardConn}
        isVisible
        onDisconnect={() => {}}
      />,
    );
    // Wait a microtask for the async listen() to resolve.
    await act(async () => {});
    expect(handler).not.toBeNull();

    await act(async () => {
      handler!({
        payload: {
          state: "client_connected",
          local_port: 9000,
          destination: "api.internal:80",
          message: null,
          active_clients: 1,
        },
      });
    });

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("1 active client");
  });

  it("renders an assertive alert when the backend reports an error state", async () => {
    let handler: ((event: { payload: TunnelStatusPayload }) => void) | null = null;
    vi.mocked(listen).mockImplementationOnce(async (_name, cb) => {
      handler = cb as typeof handler;
      return () => {};
    });

    render(
      <TunnelTab
        sessionId="s-a11y-3"
        connection={portForwardConn}
        isVisible
        onDisconnect={() => {}}
      />,
    );
    await act(async () => {});

    // Before any error the alert region must be absent — role=alert is
    // mounted on demand so its insertion triggers the AT announcement.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => {
      handler!({
        payload: {
          state: "error",
          local_port: 9000,
          destination: "api.internal:80",
          message: "bind: address already in use",
          active_clients: 0,
        },
      });
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveTextContent("bind: address already in use");
  });
});
