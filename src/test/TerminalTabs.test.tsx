import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

// react-resizable-panels uses ResizeObserver which isn't available in jsdom.
// Replace Group/Panel/Separator with simple div wrappers so split-pane tests work.
vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: () => <div role="separator" />,
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

  // ─── Error indicator ──────────────────────────────────────────────────────

  it("shows error indicator when the first pane has an error", () => {
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
      />,
    );
    expect(
      document.querySelector('[title="Connection failed"]'),
    ).toBeInTheDocument();
  });

  it("shows error indicator when only the second pane has an error", () => {
    const splitTab: TerminalTab = {
      id: "st1",
      mode: "horizontal",
      panes: [
        { sessionId: "ok-pane", connectionName: "prod-server" },
        {
          sessionId: "err-pane",
          connectionName: "dev-server",
          error: "auth failed",
          connection: mockConn,
        },
      ],
    };
    render(
      <TerminalTabs
        {...defaultProps}
        tabs={[splitTab]}
        activeTabId="st1"
      />,
    );
    expect(
      document.querySelector('[title="Connection failed"]'),
    ).toBeInTheDocument();
  });

  it("does not show error indicator when no pane has an error", () => {
    render(
      <TerminalTabs
        {...defaultProps}
        tabs={mockTabs}
        activeTabId="t1"
      />,
    );
    expect(
      document.querySelector('[title="Connection failed"]'),
    ).not.toBeInTheDocument();
  });

  // ─── Dropdown: new tab / split ────────────────────────────────────────────

  it("calls onNewTab with 'tab' when New tab is clicked", async () => {
    const onNewTab = vi.fn();
    const user = userEvent.setup();
    render(
      <TerminalTabs
        {...defaultProps}
        tabs={mockTabs}
        activeTabId="t1"
        onNewTab={onNewTab}
      />,
    );
    await user.click(screen.getByTitle("New connection"));
    await waitFor(() => screen.getByText("New tab"));
    fireEvent.click(screen.getByText("New tab"));
    expect(onNewTab).toHaveBeenCalledWith("tab");
  });

  it("calls onNewTab with 'split_right' when Split right is clicked", async () => {
    const onNewTab = vi.fn();
    const user = userEvent.setup();
    render(
      <TerminalTabs
        {...defaultProps}
        tabs={mockTabs}
        activeTabId="t1"
        onNewTab={onNewTab}
      />,
    );
    await user.click(screen.getByTitle("New connection"));
    await waitFor(() => screen.getByText("Split right"));
    fireEvent.click(screen.getByText("Split right"));
    expect(onNewTab).toHaveBeenCalledWith("split_right");
  });

  it("calls onNewTab with 'split_down' when Split down is clicked", async () => {
    const onNewTab = vi.fn();
    const user = userEvent.setup();
    render(
      <TerminalTabs
        {...defaultProps}
        tabs={mockTabs}
        activeTabId="t1"
        onNewTab={onNewTab}
      />,
    );
    await user.click(screen.getByTitle("New connection"));
    await waitFor(() => screen.getByText("Split down"));
    fireEvent.click(screen.getByText("Split down"));
    expect(onNewTab).toHaveBeenCalledWith("split_down");
  });

  it("disables Split items when there is no active tab", async () => {
    const user = userEvent.setup();
    render(
      <TerminalTabs
        {...defaultProps}
        tabs={[]}
        activeTabId={null}
      />,
    );
    await user.click(screen.getByTitle("New connection"));
    await waitFor(() => screen.getByText("Split right"));
    expect(screen.getByText("Split right")).toHaveAttribute("data-disabled");
    expect(screen.getByText("Split down")).toHaveAttribute("data-disabled");
  });

  it("disables Split items when the active tab already has 2 panes", async () => {
    const splitTab: TerminalTab = {
      id: "st1",
      mode: "horizontal",
      panes: [
        { sessionId: "p1", connectionName: "A" },
        { sessionId: "p2", connectionName: "B" },
      ],
    };
    const user = userEvent.setup();
    render(
      <TerminalTabs
        {...defaultProps}
        tabs={[splitTab]}
        activeTabId="st1"
      />,
    );
    await user.click(screen.getByTitle("New connection"));
    await waitFor(() => screen.getByText("Split right"));
    expect(screen.getByText("Split right")).toHaveAttribute("data-disabled");
    expect(screen.getByText("Split down")).toHaveAttribute("data-disabled");
  });
});
