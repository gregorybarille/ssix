import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TerminalTabs, TerminalSession } from "@/components/TerminalTabs";

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

const mockSessions: TerminalSession[] = [
  { sessionId: "sess-1", connectionName: "prod-server" },
  { sessionId: "sess-2", connectionName: "staging-server" },
  { sessionId: "sess-3", connectionName: "dev-server" },
];

describe("TerminalTabs", () => {
  it("renders tabs for each session", () => {
    render(
      <TerminalTabs
        sessions={mockSessions}
        activeTabId="sess-1"
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
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
        sessions={mockSessions}
        activeTabId="sess-1"
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
      />
    );
    expect(screen.getByTitle("New connection")).toBeInTheDocument();
  });

  it("calls onNewTab when clicking + button", () => {
    const onNewTab = vi.fn();
    render(
      <TerminalTabs
        sessions={mockSessions}
        activeTabId="sess-1"
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
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
        sessions={mockSessions}
        activeTabId="sess-1"
        onSelectTab={onSelectTab}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
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
        sessions={mockSessions}
        activeTabId="sess-1"
        onSelectTab={vi.fn()}
        onCloseTab={onCloseTab}
        onNewTab={vi.fn()}
      />
    );
    const closeButtons = screen.getAllByTitle("Close session");
    fireEvent.click(closeButtons[1]); // close the second tab
    expect(onCloseTab).toHaveBeenCalledWith("sess-2");
  });

  it("passes isVisible=true only to the active terminal", () => {
    render(
      <TerminalTabs
        sessions={mockSessions}
        activeTabId="sess-2"
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
      />
    );
    expect(screen.getByTestId("terminal-sess-1").dataset.visible).toBe("false");
    expect(screen.getByTestId("terminal-sess-2").dataset.visible).toBe("true");
    expect(screen.getByTestId("terminal-sess-3").dataset.visible).toBe("false");
  });

  it("renders empty state with just the + button", () => {
    render(
      <TerminalTabs
        sessions={[]}
        activeTabId={null}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTab={vi.fn()}
      />
    );
    expect(screen.getByTitle("New connection")).toBeInTheDocument();
  });
});
