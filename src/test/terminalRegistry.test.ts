import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { TerminalTab } from "@/components/TerminalTabs";
import {
  activeSessionId,
  registerTerminal,
  terminalText,
  unregisterTerminal,
  writeToSession,
} from "@/lib/terminalRegistry";
import { useTerminalsStore } from "@/store/useTerminalsStore";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ invoke }));

/** A registered terminal whose input element can be focused. */
function liveTerminal(sessionId: string): { focus: () => void } {
  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  registerTerminal(sessionId, { textarea } as unknown as XTerm);
  return { focus: () => textarea.dispatchEvent(new FocusEvent("focus")) };
}

function tab(id: string, ...sessionIds: string[]): TerminalTab {
  return {
    id,
    mode: sessionIds.length > 1 ? "horizontal" : "single",
    panes: sessionIds.map((sessionId) => ({ sessionId, connectionName: sessionId })),
  };
}

describe("terminalRegistry", () => {
  const sessions = ["s1", "s2", "s3"];

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  afterEach(() => {
    sessions.forEach(unregisterTerminal);
    useTerminalsStore.setState({ tabs: [], activeTabId: null });
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  describe("writeToSession", () => {
    it("sends the text through ssh_write, like keyboard input", () => {
      liveTerminal("s1");
      expect(writeToSession("s1", "uptime\r")).toBe(true);
      expect(invoke).toHaveBeenCalledWith("ssh_write", { sessionId: "s1", data: "uptime\r" });
    });

    it("refuses a session with no live terminal without calling the backend", () => {
      expect(writeToSession("unknown", "uptime\r")).toBe(false);
      expect(invoke).not.toHaveBeenCalled();
    });

    it("refuses a session once its terminal is gone", () => {
      liveTerminal("s1");
      unregisterTerminal("s1");
      expect(writeToSession("s1", "uptime\r")).toBe(false);
      expect(invoke).not.toHaveBeenCalled();
    });

    it("logs a write the backend rejects", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      invoke.mockRejectedValue("session not found");
      liveTerminal("s1");
      expect(writeToSession("s1", "uptime\r")).toBe(true);
      await vi.waitFor(() => expect(logged).toHaveBeenCalled());
      expect(logged.mock.calls[0][1]).toContain("session not found");
    });
  });

  describe("activeSessionId", () => {
    it("is null with no tab open", () => {
      expect(activeSessionId()).toBeNull();
    });

    it("is null when no tab is active", () => {
      liveTerminal("s1");
      useTerminalsStore.setState({ tabs: [tab("t1", "s1")], activeTabId: null });
      expect(activeSessionId()).toBeNull();
    });

    it("is the only pane of the active tab", () => {
      liveTerminal("s1");
      liveTerminal("s2");
      useTerminalsStore.setState({ tabs: [tab("t1", "s1"), tab("t2", "s2")], activeTabId: "t2" });
      expect(activeSessionId()).toBe("s2");
    });

    it("defaults to the first pane of a split", () => {
      liveTerminal("s1");
      liveTerminal("s2");
      useTerminalsStore.setState({ tabs: [tab("t1", "s1", "s2")], activeTabId: "t1" });
      expect(activeSessionId()).toBe("s1");
    });

    it("follows the pane that last had focus, even after focus left it", () => {
      liveTerminal("s1");
      const second = liveTerminal("s2");
      useTerminalsStore.setState({ tabs: [tab("t1", "s1", "s2")], activeTabId: "t1" });
      second.focus();
      expect(activeSessionId()).toBe("s2");
    });

    it("ignores focus in a pane of another tab", () => {
      liveTerminal("s1");
      const other = liveTerminal("s2");
      useTerminalsStore.setState({ tabs: [tab("t1", "s1"), tab("t2", "s2")], activeTabId: "t1" });
      other.focus();
      expect(activeSessionId()).toBe("s1");
    });

    it("skips a failed pane, which has no terminal", () => {
      liveTerminal("s2");
      useTerminalsStore.setState({ tabs: [tab("t1", "failed", "s2")], activeTabId: "t1" });
      expect(activeSessionId()).toBe("s2");
    });

    it("is null when every pane of the active tab failed", () => {
      useTerminalsStore.setState({ tabs: [tab("t1", "failed")], activeTabId: "t1" });
      expect(activeSessionId()).toBeNull();
    });

    it("falls back when the focused pane closes", () => {
      liveTerminal("s1");
      const second = liveTerminal("s2");
      useTerminalsStore.setState({ tabs: [tab("t1", "s1", "s2")], activeTabId: "t1" });
      second.focus();
      unregisterTerminal("s2");
      expect(activeSessionId()).toBe("s1");
    });
  });

  it("terminalText is null for an unknown session", () => {
    expect(terminalText("unknown")).toBeNull();
  });
});
