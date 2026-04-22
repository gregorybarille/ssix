import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  TerminalTabs,
  TerminalSession,
  TerminalTab,
} from "@/components/TerminalTabs";
import { Connection } from "@/types";

vi.mock("@/components/Terminal", () => ({
  Terminal: ({ sessionId, connectionName, isVisible }: {
    sessionId: string;
    connectionName: string;
    isVisible: boolean;
  }) => (
    <div data-testid={`terminal-${sessionId}`} data-visible={isVisible}>
      {connectionName}
    </div>
  ),
}));

const defaultProps = {
  onSelectTab: vi.fn(),
  onCloseTab: vi.fn(),
  onClosePane: vi.fn(),
  onNewTab: vi.fn(),
  onRetry: vi.fn(),
  onEdit: vi.fn(),
};

const tab = (id: string, panes: TerminalSession[]): TerminalTab => ({
  id,
  mode: "single",
  panes,
});

const mockTabs: TerminalTab[] = [
  tab("t1", [{ sessionId: "sess-1", connectionName: "prod-server" }]),
  tab("t2", [{ sessionId: "sess-2", connectionName: "staging-server" }]),
  tab("t3", [{ sessionId: "sess-3", connectionName: "dev-server" }]),
];

const mockConn: Connection = {
  id: "conn-1",
  name: "prod-server",
  host: "bad-host",
  port: 22,
  type: "direct",
};

describe("TerminalTabs", () => {
  it("renders tabs for each session", () => {
    render(
      <TerminalTabs
        {...defaultProps}
        tabs={mockTabs}
        activeTabId="t1"
      />,
    );
    expect(screen.getAllByText("prod-server")).toHaveLength(2);
    expect(screen.getAllByText("staging-server")).toHaveLength(2);
    expect(screen.getAllByText("dev-server")).toHaveLength(2);
  });

  it("renders the + button for new tab", () => {
    render(
      <TerminalTabs
        {...defaultProps}
        tabs={mockTabs}
        activeTabId="t1"
      />,
    );
    expect(screen.getByTitle("New connection")).toBeInTheDocument();
  });

  it("calls onSelectTab when clicking a tab", () => {
    const onSelectTab = vi.fn();
    render(
      <TerminalTabs
        {...defaultProps}
        tabs={mockTabs}
        activeTabId="t1"
        onSelectTab={onSelectTab}
      />,
    );
    const matches = screen.getAllByText("staging-server");
    fireEvent.click(matches[0]);
    expect(onSelectTab).toHaveBeenCalledWith("t2");
  });

  it("calls onCloseTab when clicking close button on a tab", () => {
    const onCloseTab = vi.fn();
    render(
      <TerminalTabs
        {...defaultProps}
        tabs={mockTabs}
        activeTabId="t1"
        onCloseTab={onCloseTab}
      />,
    );
    const closeButtons = screen.getAllByTitle("Close tab");
    fireEvent.click(closeButtons[1]);
    expect(onCloseTab).toHaveBeenCalledWith("t2");
  });

  it("passes isVisible=true only to the active tab's pane", () => {
    render(
      <TerminalTabs
        {...defaultProps}
        tabs={mockTabs}
        activeTabId="t2"
      />,
    );
    expect(screen.getByTestId("terminal-sess-1").dataset.visible).toBe("false");
    expect(screen.getByTestId("terminal-sess-2").dataset.visible).toBe("true");
    expect(screen.getByTestId("terminal-sess-3").dataset.visible).toBe("false");
  });

  it("renders empty state with just the + button", () => {
    render(
      <TerminalTabs
        {...defaultProps}
        tabs={[]}
        activeTabId={null}
      />,
    );
    expect(screen.getByTitle("New connection")).toBeInTheDocument();
  });

  it("renders FailedTerminal with Retry and Edit buttons for errored sessions", () => {
    const onRetry = vi.fn();
    const onEdit = vi.fn();
    const failedTab = tab("ft1", [
      {
        sessionId: "failed-1",
        connectionName: "prod-server",
        error: "TCP connect to bad-host:22 failed",
        connection: mockConn,
      },
    ]);
    render(
      <TerminalTabs
        {...defaultProps}
        tabs={[failedTab]}
        activeTabId="ft1"
        onRetry={onRetry}
        onEdit={onEdit}
      />,
    );
    expect(
      screen.getByText(/TCP connect to bad-host:22 failed/),
    ).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
    expect(screen.getByText("Edit Connection")).toBeInTheDocument();
  });

  it("calls onRetry with the connection when Retry is clicked", () => {
    const onRetry = vi.fn();
    const failedTab = tab("ft1", [
      {
        sessionId: "failed-1",
        connectionName: "prod-server",
        error: "TCP connect failed",
        connection: mockConn,
      },
    ]);
    render(
      <TerminalTabs
        {...defaultProps}
        tabs={[failedTab]}
        activeTabId="ft1"
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalledWith(mockConn, "failed-1");
  });

  it("calls onEdit with the connection when Edit Connection is clicked", () => {
    const onEdit = vi.fn();
    const failedTab = tab("ft1", [
      {
        sessionId: "failed-1",
        connectionName: "prod-server",
        error: "TCP connect failed",
        connection: mockConn,
      },
    ]);
    render(
      <TerminalTabs
        {...defaultProps}
        tabs={[failedTab]}
        activeTabId="ft1"
        onEdit={onEdit}
      />,
    );
    fireEvent.click(screen.getByText("Edit Connection"));
    expect(onEdit).toHaveBeenCalledWith(mockConn, "failed-1");
  });
});
