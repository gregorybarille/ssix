import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TerminalTabs, TerminalSession } from "@/components/TerminalTabs";
import { Connection } from "@/types";

// Mock Terminal since it uses xterm.js which doesn't work in jsdom
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
  onNewTab: vi.fn(),
  onRetry: vi.fn(),
  onEdit: vi.fn(),
};

const mockSessions: TerminalSession[] = [
  { sessionId: "sess-1", connectionName: "prod-server" },
  { sessionId: "sess-2", connectionName: "staging-server" },
  { sessionId: "sess-3", connectionName: "dev-server" },
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
        sessions={mockSessions}
        activeTabId="sess-1"
      />
    );
    // Each name appears in both the tab bar and the mocked terminal
    expect(screen.getAllByText("prod-server")).toHaveLength(2);
    expect(screen.getAllByText("staging-server")).toHaveLength(2);
    expect(screen.getAllByText("dev-server")).toHaveLength(2);
  });

  it("renders the + button for new tab", () => {
    render(
      <TerminalTabs
        {...defaultProps}
        sessions={mockSessions}
        activeTabId="sess-1"
      />
    );
    expect(screen.getByTitle("New connection")).toBeInTheDocument();
  });

  it("calls onNewTab when clicking + button", () => {
    const onNewTab = vi.fn();
    render(
      <TerminalTabs
        {...defaultProps}
        sessions={mockSessions}
        activeTabId="sess-1"
        onNewTab={onNewTab}
      />
    );
    fireEvent.click(screen.getByTitle("New connection"));
    expect(onNewTab).toHaveBeenCalledOnce();
  });

  it("calls onSelectTab when clicking a tab", () => {
    const onSelectTab = vi.fn();
    render(
      <TerminalTabs
        {...defaultProps}
        sessions={mockSessions}
        activeTabId="sess-1"
        onSelectTab={onSelectTab}
      />
    );
    // Click the tab span (first match is the tab, second is the mocked terminal)
    const matches = screen.getAllByText("staging-server");
    fireEvent.click(matches[0]);
    expect(onSelectTab).toHaveBeenCalledWith("sess-2");
  });

  it("calls onCloseTab when clicking close button on a tab", () => {
    const onCloseTab = vi.fn();
    render(
      <TerminalTabs
        {...defaultProps}
        sessions={mockSessions}
        activeTabId="sess-1"
        onCloseTab={onCloseTab}
      />
    );
    const closeButtons = screen.getAllByTitle("Close session");
    fireEvent.click(closeButtons[1]); // close the second tab
    expect(onCloseTab).toHaveBeenCalledWith("sess-2");
  });

  it("passes isVisible=true only to the active terminal", () => {
    render(
      <TerminalTabs
        {...defaultProps}
        sessions={mockSessions}
        activeTabId="sess-2"
      />
    );
    expect(screen.getByTestId("terminal-sess-1").dataset.visible).toBe("false");
    expect(screen.getByTestId("terminal-sess-2").dataset.visible).toBe("true");
    expect(screen.getByTestId("terminal-sess-3").dataset.visible).toBe("false");
  });

  it("renders empty state with just the + button", () => {
    render(
      <TerminalTabs
        {...defaultProps}
        sessions={[]}
        activeTabId={null}
      />
    );
    expect(screen.getByTitle("New connection")).toBeInTheDocument();
  });

  it("renders FailedTerminal with Retry and Edit buttons for errored sessions", () => {
    const onRetry = vi.fn();
    const onEdit = vi.fn();
    const failedSession: TerminalSession = {
      sessionId: "failed-1",
      connectionName: "prod-server",
      error: "TCP connect to bad-host:22 failed",
      connection: mockConn,
    };
    render(
      <TerminalTabs
        {...defaultProps}
        sessions={[failedSession]}
        activeTabId="failed-1"
        onRetry={onRetry}
        onEdit={onEdit}
      />
    );
    expect(screen.getByText(/TCP connect to bad-host:22 failed/)).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
    expect(screen.getByText("Edit Connection")).toBeInTheDocument();
  });

  it("calls onRetry with the connection when Retry is clicked", () => {
    const onRetry = vi.fn();
    const failedSession: TerminalSession = {
      sessionId: "failed-1",
      connectionName: "prod-server",
      error: "TCP connect failed",
      connection: mockConn,
    };
    render(
      <TerminalTabs
        {...defaultProps}
        sessions={[failedSession]}
        activeTabId="failed-1"
        onRetry={onRetry}
      />
    );
    fireEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalledWith(mockConn, "failed-1");
  });

  it("calls onEdit with the connection when Edit Connection is clicked", () => {
    const onEdit = vi.fn();
    const failedSession: TerminalSession = {
      sessionId: "failed-1",
      connectionName: "prod-server",
      error: "TCP connect failed",
      connection: mockConn,
    };
    render(
      <TerminalTabs
        {...defaultProps}
        sessions={[failedSession]}
        activeTabId="failed-1"
        onEdit={onEdit}
      />
    );
    fireEvent.click(screen.getByText("Edit Connection"));
    expect(onEdit).toHaveBeenCalledWith(mockConn, "failed-1");
  });
});
