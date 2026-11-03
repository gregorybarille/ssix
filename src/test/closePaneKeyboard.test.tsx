import { act, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalTabs, type TerminalTab } from "@/components/TerminalTabs";
import { focusSession } from "@/lib/terminalRegistry";
import { useDialogsStore } from "@/store/useDialogsStore";

vi.mock("@/lib/terminalRegistry", async (original) => ({
  ...(await original<typeof import("@/lib/terminalRegistry")>()),
  focusSession: vi.fn(),
}));

vi.mock("@/components/Terminal", () => ({
  Terminal: ({ sessionId }: { sessionId: string }) => <div data-testid={`terminal-${sessionId}`} />,
}));

vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: () => <div role="separator" />,
}));

const handlers = {
  onSelectTab: vi.fn(),
  onCloseTab: vi.fn(),
  onClosePane: vi.fn(),
  onNewTab: vi.fn(),
  onRetry: vi.fn(),
  onEdit: vi.fn(),
};

const stays = { sessionId: "stays", connectionName: "stays" };
const goes = { sessionId: "goes", connectionName: "goes" };
const withPanes = (panes: TerminalTab["panes"]): TerminalTab[] => [
  { id: "tab", mode: "single", panes },
];

function renderSplit() {
  const view = render(
    <TerminalTabs {...handlers} tabs={withPanes([stays, goes])} activeTabId="tab" />,
  );
  return () =>
    view.rerender(<TerminalTabs {...handlers} tabs={withPanes([stays])} activeTabId="tab" />);
}

const ask = () =>
  act(() => useDialogsStore.getState().askClosePane({ kind: "pane", sessionId: "goes", name: "goes" }));
const answer = () => act(() => useDialogsStore.getState().closePaneAnswered());

describe("the keyboard when a split pane closes", () => {
  beforeEach(() => {
    vi.mocked(focusSession).mockClear();
    useDialogsStore.setState({ confirmClosePane: null, closePaneQueue: [] });
  });

  afterEach(() => {
    useDialogsStore.setState({ confirmClosePane: null, closePaneQueue: [] });
    document.body.innerHTML = "";
  });

  it("comes to the terminal that stays at once when nothing asked", () => {
    const closeSecondPane = renderSplit();
    closeSecondPane();
    expect(focusSession).toHaveBeenCalledExactlyOnceWith("stays");
  });

  it("waits for the answer to the question that closed the pane", () => {
    const closeSecondPane = renderSplit();
    ask();
    closeSecondPane();
    expect(focusSession).not.toHaveBeenCalled();

    answer();
    expect(focusSession).toHaveBeenCalledExactlyOnceWith("stays");
  });

  it("is not taken from someone typing by then", () => {
    const closeSecondPane = renderSplit();
    ask();
    closeSecondPane();

    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    answer();
    expect(focusSession).not.toHaveBeenCalled();
    expect(field).toHaveFocus();
  });

  it("does not move again on a later question", () => {
    const closeSecondPane = renderSplit();
    closeSecondPane();
    vi.mocked(focusSession).mockClear();

    ask();
    answer();
    expect(focusSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("terminal-stays")).toBeInTheDocument();
  });
});
