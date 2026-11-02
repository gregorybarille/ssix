import { beforeEach, describe, expect, it } from "vitest";
import type { TerminalTab } from "@/components/TerminalTabs";
import { useDialogsStore, type ClosePaneTarget } from "@/store/useDialogsStore";
import { useTerminalsStore } from "@/store/useTerminalsStore";

const split = (id: string, ...sessionIds: string[]): TerminalTab => ({
  id,
  mode: "horizontal",
  panes: sessionIds.map((sessionId) => ({ sessionId, connectionName: sessionId })),
});
const pane = (sessionId: string): ClosePaneTarget => ({ kind: "pane", sessionId, name: sessionId });
const tab = (tabId: string): ClosePaneTarget => ({ kind: "tab", tabId, name: tabId });

const dialogs = () => useDialogsStore.getState();
const onScreen = () => dialogs().confirmClosePane;

describe("the questions about closing a terminal", () => {
  beforeEach(() => {
    useTerminalsStore.setState({ tabs: [split("t1", "a", "b"), split("t2", "c")], activeTabId: "t1" });
    useDialogsStore.setState({ confirmClosePane: null, closePaneQueue: [], closePaneTurn: 0 });
  });

  it("asks at once when nothing else is being asked", () => {
    dialogs().askClosePane(pane("a"));
    expect(onScreen()).toEqual(pane("a"));
  });

  it("asks about both panes of a split that ended, one after the other", () => {
    dialogs().askClosePane(pane("a"));
    dialogs().askClosePane(pane("b"));
    expect(onScreen()).toEqual(pane("a"));

    dialogs().closePaneAnswered();
    expect(onScreen()).toEqual(pane("b"));

    dialogs().closePaneAnswered();
    expect(onScreen()).toBeNull();
  });

  it("does not replace an open question with an unrelated one", () => {
    dialogs().askClosePane(pane("a"));
    dialogs().askClosePane(tab("t2"));
    expect(onScreen()).toEqual(pane("a"));
    dialogs().closePaneAnswered();
    expect(onScreen()).toEqual(tab("t2"));
  });

  it("asks once about the same thing", () => {
    dialogs().askClosePane(pane("a"));
    dialogs().askClosePane(pane("a"));
    dialogs().askClosePane(pane("b"));
    dialogs().askClosePane(pane("b"));
    expect(dialogs().closePaneQueue).toEqual([pane("b")]);
    dialogs().closePaneAnswered();
    dialogs().closePaneAnswered();
    expect(onScreen()).toBeNull();
  });

  it("skips what closed while its question waited", () => {
    dialogs().askClosePane(tab("t1"));
    dialogs().askClosePane(pane("b"));
    dialogs().askClosePane(pane("c"));

    useTerminalsStore.setState({ tabs: [split("t2", "c")] });
    dialogs().closePaneAnswered();
    expect(onScreen()).toEqual(pane("c"));
    expect(dialogs().closePaneQueue).toEqual([]);
  });

  it("counts only the questions that took over from another", () => {
    dialogs().askClosePane(pane("a"));
    expect(dialogs().closePaneTurn).toBe(0);
    dialogs().askClosePane(pane("b"));
    dialogs().closePaneAnswered();
    expect(dialogs().closePaneTurn).toBe(1);
    dialogs().closePaneAnswered();
    expect(dialogs().closePaneTurn).toBe(1);
  });
});
