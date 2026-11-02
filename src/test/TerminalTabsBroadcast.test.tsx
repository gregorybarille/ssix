import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TerminalTabs,
  type TerminalSession,
  type TerminalTab,
} from "@/components/TerminalTabs";
import { useConnectionsStore } from "@/store/useConnectionsStore";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import type { Connection } from "@/types";
import { terminalTabsCallbacks } from "./terminalTabsCallbacks";

vi.mock("@/components/Terminal", () => ({
  Terminal: ({
    sessionId,
    isVisible,
    connection,
  }: {
    sessionId: string;
    isVisible: boolean;
    connection?: Connection;
  }) => (
    <div
      data-testid={`terminal-${sessionId}`}
      data-visible={isVisible}
      data-scheme={connection?.color_scheme ?? ""}
    />
  ),
}));
const callbacks = terminalTabsCallbacks();

const live = (sessionId: string): TerminalSession => ({ sessionId, connectionName: sessionId });
const split = (panes: TerminalSession[], broadcast = false): TerminalTab => ({
  id: "t1",
  mode: "horizontal",
  panes,
  broadcast,
});

function renderTabs(tabs: TerminalTab[], hidden = false) {
  useTerminalsStore.setState({ tabs, activeTabId: tabs[0].id });
  return render(<TerminalTabs {...callbacks} tabs={tabs} activeTabId={tabs[0].id} hidden={hidden} />);
}

const toggle = () => screen.getByTestId("broadcast-toggle");

beforeEach(() => {
  useTerminalsStore.setState({ tabs: [], activeTabId: null });
  useConnectionsStore.setState({ connections: [] });
});

describe("the broadcast toggle", () => {
  it("is off by default, with nothing telling otherwise", () => {
    renderTabs([split([live("a"), live("b")])]);
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(toggle()).toHaveTextContent("Broadcast input");
    expect(toggle()).toBeEnabled();
    expect(screen.queryByTestId("broadcast-indicator")).toBeNull();
    expect(screen.getByRole("tab").getAttribute("aria-label")).not.toContain("broadcasting");
  });

  it("cannot be turned on with a single pane", () => {
    renderTabs([{ id: "t1", mode: "single", panes: [live("a")] }]);
    expect(toggle()).toBeDisabled();
    expect(toggle()).toHaveAttribute("title", expect.stringContaining("Split this tab"));
  });

  it("calls the store for the active tab", () => {
    renderTabs([split([live("a"), live("b")])]);
    fireEvent.click(toggle());
    expect(useTerminalsStore.getState().tabs[0].broadcast).toBe(true);
  });

  it("is hard to miss while on: the button, a frame around the panes and the tab say so", () => {
    renderTabs([split([live("a"), live("b")], true)]);
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    expect(toggle()).toHaveTextContent("Broadcasting to 2 of 2 panes");
    expect(screen.getByTestId("broadcast-indicator")).toBeInTheDocument();
    expect(screen.getByRole("tab").getAttribute("aria-label")).toContain("broadcasting input");
  });

  it("counts only the panes actually receiving", () => {
    const dropped: TerminalSession = {
      ...live("b"),
      reconnect: { phase: "waiting", attempt: 1, maxAttempts: 5, retryAt: 0, message: "gone" },
    };
    renderTabs([split([live("a"), dropped], true)]);
    expect(toggle()).toHaveTextContent("Broadcasting to 1 of 2 panes");
  });

  it("says so on a broadcasting tab that is not the active one", () => {
    const background = { ...split([live("c"), live("d")], true), id: "t2" };
    renderTabs([{ id: "t1", mode: "single", panes: [live("a")] }, background]);
    const [, second] = screen.getAllByRole("tab");
    expect(second.getAttribute("aria-label")).toContain("broadcasting input");
  });
});

describe("TerminalTabs hidden", () => {
  it("keeps every terminal mounted and marks none of them visible", () => {
    const view = renderTabs([split([live("a"), live("b")])], true);
    expect(screen.getByTestId("terminal-a").dataset.visible).toBe("false");
    expect(screen.getByTestId("terminal-b").dataset.visible).toBe("false");
    expect(view.container.firstElementChild).toHaveStyle({ display: "none" });

    view.rerender(
      <TerminalTabs
        {...callbacks}
        tabs={[split([live("a"), live("b")])]}
        activeTabId="t1"
        hidden={false}
      />,
    );
    expect(screen.getByTestId("terminal-a").dataset.visible).toBe("true");
    expect(screen.getByTestId("terminal-b").dataset.visible).toBe("true");
    expect(view.container.firstElementChild).not.toHaveStyle({ display: "none" });
  });
});

describe("a pane's look", () => {
  const opened: Connection = { id: "c1", name: "web", host: "h", port: 22, type: "direct" };

  it("follows an edit saved after the pane opened", () => {
    useConnectionsStore.setState({ connections: [{ ...opened, color_scheme: "nord" }] });
    renderTabs([{ id: "t1", mode: "single", panes: [{ ...live("a"), connection: opened }] }]);
    expect(screen.getByTestId("terminal-a").dataset.scheme).toBe("nord");
  });

  it("keeps the connection it opened with once that connection is deleted", () => {
    renderTabs([
      {
        id: "t1",
        mode: "single",
        panes: [{ ...live("a"), connection: { ...opened, color_scheme: "dracula" } }],
      },
    ]);
    expect(screen.getByTestId("terminal-a").dataset.scheme).toBe("dracula");
  });
});
