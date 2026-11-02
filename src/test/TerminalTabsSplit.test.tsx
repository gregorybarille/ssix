import { render } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TerminalTabs,
  type SplitMode,
  type TerminalSession,
  type TerminalTab,
} from "@/components/TerminalTabs";
import { registerTerminal, unregisterTerminal } from "@/lib/terminalRegistry";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import type { Terminal as XTerm } from "@xterm/xterm";
import { terminalTabsCallbacks } from "./terminalTabsCallbacks";

const mounts = vi.hoisted(() => [] as string[]);

/** An xterm lives exactly as long as this does: see the `[sessionId]` effect of the real one. */
vi.mock("@/components/Terminal", () => ({
  Terminal: ({ sessionId }: { sessionId: string }) => {
    React.useEffect(() => {
      mounts.push(`mount ${sessionId}`);
      return () => {
        mounts.push(`unmount ${sessionId}`);
      };
    }, [sessionId]);
    return <div data-testid={`terminal-${sessionId}`} />;
  },
}));

const callbacks = terminalTabsCallbacks();
const live = (sessionId: string): TerminalSession => ({ sessionId, connectionName: sessionId });
const tab = (mode: SplitMode, ...ids: string[]): TerminalTab => ({
  id: "t1",
  mode,
  panes: ids.map(live),
});
const element = (t: TerminalTab) => (
  <TerminalTabs {...callbacks} tabs={[t]} activeTabId={t.id} />
);

beforeEach(() => {
  mounts.length = 0;
  useTerminalsStore.setState({ tabs: [], activeTabId: null });
});

describe("a terminal whose tab is split", () => {
  it.each<[string, SplitMode]>([
    ["to the right", "horizontal"],
    ["down", "vertical"],
  ])("stays the same terminal when split %s and when the split closes", (_name, mode) => {
    const view = render(element(tab("single", "a")));
    view.rerender(element(tab(mode, "a", "b")));
    view.rerender(element(tab("single", "a")));
    expect(mounts).toEqual(["mount a", "mount b", "unmount b"]);
  });

  it("stays the same terminal when the pane that goes is the first one", () => {
    const view = render(element(tab("horizontal", "a", "b")));
    view.rerender(element(tab("single", "b")));
    expect(mounts).toEqual(["mount a", "mount b", "unmount a"]);
  });

  it("stays the same terminal when the new pane stops being a placeholder", () => {
    const view = render(element(tab("single", "a")));
    view.rerender(element(tab("horizontal", "a", "placeholder")));
    view.rerender(element(tab("horizontal", "a", "b")));
    expect(mounts.filter((entry) => entry.endsWith(" a"))).toEqual(["mount a"]);
  });

  it("gets a panel to itself, in the tab panel", () => {
    render(element(tab("single", "a")));
    const panel = document.querySelector('[data-panel][id="a"]');
    expect(panel).not.toBeNull();
    expect(panel?.closest('[role="tabpanel"]')?.id).toBe("terminal-panel-t1");
  });
});

describe("the keyboard when a split closes", () => {
  const focus = vi.fn();

  beforeEach(() => {
    focus.mockClear();
    registerTerminal("a", { focus, textarea: null } as unknown as XTerm);
  });

  afterEach(() => {
    unregisterTerminal("a");
    document.body.replaceChildren();
  });

  const closeSplit = (visible = true) => {
    const hidden = !visible;
    const view = render(
      <TerminalTabs {...callbacks} tabs={[tab("horizontal", "a", "b")]} activeTabId="t1" hidden={hidden} />,
    );
    view.rerender(
      <TerminalTabs {...callbacks} tabs={[tab("single", "a")]} activeTabId="t1" hidden={hidden} />,
    );
  };

  it("goes to the pane that stays", () => {
    closeSplit();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("does not move for a tab that was alone from the start", () => {
    render(element(tab("single", "a")));
    expect(focus).not.toHaveBeenCalled();
  });

  it("stays with someone typing elsewhere", () => {
    const input = document.body.appendChild(document.createElement("input"));
    input.focus();
    closeSplit();
    expect(focus).not.toHaveBeenCalled();
  });

  it("stays with a panel", () => {
    const panel = document.body.appendChild(document.createElement("div"));
    panel.dataset.slot = "app-panel-content";
    closeSplit();
    expect(focus).not.toHaveBeenCalled();
  });

  it("stays out of a tab that is off screen", () => {
    closeSplit(false);
    expect(focus).not.toHaveBeenCalled();
  });
});
