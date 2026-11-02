import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { Terminal as XTerm } from "@xterm/xterm";
import { SnippetPalette } from "@/components/SnippetPalette";
import { invoke } from "@/lib/tauri";
import { NO_TERMINAL_MESSAGE, SEVERAL_LINES_MESSAGE } from "@/lib/snippets";
import { registerTerminal, unregisterTerminal } from "@/lib/terminalRegistry";
import { useSnippetsStore } from "@/store/useSnippetsStore";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import { useViewStore } from "@/store/useViewStore";
import type { Snippet } from "@/types";
import { renderInPanel } from "./panel";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));

const mockInvoke = vi.mocked(invoke);

const uptime: Snippet = { id: "1", name: "uptime", command: "uptime", tags: ["ops"] };
const newline: Snippet = { id: "2", name: "trailing", command: "df -h\n" };
const lines: Snippet = { id: "3", name: "two-lines", command: "cd /tmp\nls" };
const greet: Snippet = {
  id: "4",
  name: "greet",
  command: "echo {{who}} {{ who }} from {{place}}",
};
const linesWithVariable: Snippet = { id: "5", name: "lines-var", command: "cd {{dir}}\nls" };
const proto: Snippet = { id: "6", name: "proto", command: "echo {{constructor}} {{__proto__}}" };
const docker: Snippet = { id: "7", name: "docker", command: "docker ps --format '{{.Names}}' {{" };
const all = [uptime, newline, lines, greet, linesWithVariable, proto, docker];

function liveTerminal(sessionId: string, bracketedPasteMode = false) {
  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  const focus = vi.fn();
  registerTerminal(sessionId, { textarea, focus, modes: { bracketedPasteMode } } as unknown as XTerm);
  return { focus, textarea };
}

function activate(...sessionIds: string[]) {
  useTerminalsStore.setState({
    tabs: [
      {
        id: "t1",
        mode: sessionIds.length > 1 ? "horizontal" : "single",
        panes: sessionIds.map((sessionId) => ({
          sessionId,
          connectionName: `conn-${sessionId}`,
        })),
      },
    ],
    activeTabId: "t1",
  });
}

async function openPalette(snippets: Snippet[] = all) {
  mockInvoke.mockImplementation(async (cmd: string) => (cmd === "get_snippets" ? snippets : undefined));
  useSnippetsStore.setState({ snippets, paletteOpen: true });
  renderInPanel(<SnippetPalette />);
  return screen.findByTestId("snippet-palette");
}

const search = () => screen.getByTestId("snippet-palette-search");
const writes = () => mockInvoke.mock.calls.filter(([cmd]) => cmd === "ssh_write");
const option = (name: string) =>
  document.querySelector<HTMLElement>(`[data-testid="snippet-palette-option"][data-name="${name}"]`);
const variable = (name: string) =>
  document.querySelector<HTMLInputElement>(`[data-testid="snippet-variable"][data-name="${name}"]`);
const paletteOpen = () => useSnippetsStore.getState().paletteOpen;

describe("SnippetPalette", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    useSnippetsStore.setState({ snippets: [], error: null, isLoading: false, paletteOpen: false });
  });

  afterEach(() => {
    ["s1", "s2"].forEach(unregisterTerminal);
    useTerminalsStore.setState({ tabs: [], activeTabId: null });
    document.body.innerHTML = "";
  });

  describe("opening", () => {
    it("renders nothing while closed", () => {
      renderInPanel(<SnippetPalette />);
      expect(screen.queryByTestId("snippet-palette")).not.toBeInTheDocument();
    });

    it("docks in the side panel, not as an overlay", async () => {
      liveTerminal("s1");
      activate("s1");
      const palette = await openPalette();
      expect(palette).toHaveAttribute("data-kind", "panel");
      expect(screen.getByTestId("app-panel-slot")).toContainElement(palette);
    });

    it("focuses the search box", async () => {
      await openPalette();
      expect(search()).toHaveFocus();
    });

    it("says which pane it pastes into and that nothing runs", async () => {
      liveTerminal("s1");
      activate("s1");
      await openPalette();
      const target = screen.getByTestId("snippet-palette-target");
      expect(target).toHaveTextContent("conn-s1");
      expect(target).toHaveTextContent("Nothing runs until you press Enter");
    });

    it("follows the pane the user clicks", async () => {
      liveTerminal("s1");
      const second = liveTerminal("s2");
      activate("s1", "s2");
      await openPalette();
      expect(screen.getByTestId("snippet-palette-target")).toHaveTextContent("conn-s1");
      act(() => second.textarea.focus());
      expect(screen.getByTestId("snippet-palette-target")).toHaveTextContent("conn-s2");
    });

    it("notices a terminal that registered right after the palette rendered", async () => {
      activate("s1");
      await openPalette();
      expect(screen.getByTestId("snippet-palette-error")).toHaveTextContent(NO_TERMINAL_MESSAGE);
      liveTerminal("s1");
      act(() => useTerminalsStore.setState({ activeTabId: "t1", tabs: [...useTerminalsStore.getState().tabs] }));
      expect(screen.queryByTestId("snippet-palette-error")).not.toBeInTheDocument();
    });

    it("notices the terminal going away with the view it lives on", async () => {
      useViewStore.setState({ view: "terminals", leaveGuard: null });
      liveTerminal("s1");
      activate("s1");
      await openPalette();
      expect(screen.queryByTestId("snippet-palette-error")).not.toBeInTheDocument();
      unregisterTerminal("s1");
      act(() => useViewStore.getState().setView("connections"));
      expect(screen.getByTestId("snippet-palette-error")).toHaveTextContent(NO_TERMINAL_MESSAGE);
      expect(screen.getByTestId("snippet-palette-target")).toHaveTextContent(
        "the active terminal",
      );
    });

    it("shows a load failure with a retry", async () => {
      mockInvoke.mockRejectedValue("disk on fire");
      useSnippetsStore.setState({ paletteOpen: true });
      renderInPanel(<SnippetPalette />);
      const banner = await screen.findByTestId("snippet-palette-load-error");
      expect(banner).toHaveTextContent("disk on fire");
      mockInvoke.mockResolvedValue([uptime]);
      fireEvent.click(screen.getByTestId("snippet-palette-load-error-retry"));
      await waitFor(() => expect(option("uptime")).toBeInTheDocument());
      expect(screen.queryByTestId("snippet-palette-load-error")).not.toBeInTheDocument();
    });

    it("says when there are no snippets", async () => {
      await openPalette([]);
      expect(screen.getByText(/No snippets yet/)).toBeInTheDocument();
    });
  });

  describe("filtering", () => {
    it("filters by name, command and tag", async () => {
      await openPalette();
      fireEvent.change(search(), { target: { value: "ops" } });
      expect(option("uptime")).toBeInTheDocument();
      expect(option("trailing")).not.toBeInTheDocument();
      fireEvent.change(search(), { target: { value: "df -h" } });
      expect(option("trailing")).toBeInTheDocument();
      expect(option("uptime")).not.toBeInTheDocument();
      fireEvent.change(search(), { target: { value: "GREET" } });
      expect(option("greet")).toBeInTheDocument();
    });

    it("says when nothing matches, and Enter then does nothing", async () => {
      liveTerminal("s1");
      activate("s1");
      await openPalette();
      fireEvent.change(search(), { target: { value: "zzz" } });
      expect(screen.getByText(/No matches for/)).toBeInTheDocument();
      fireEvent.keyDown(search(), { key: "Enter" });
      expect(writes()).toEqual([]);
      expect(paletteOpen()).toBe(true);
    });

    it("moves the active row with the keyboard and pastes it", async () => {
      liveTerminal("s1");
      activate("s1");
      await openPalette();
      fireEvent.keyDown(search(), { key: "ArrowDown" });
      expect(option("trailing")).toHaveAttribute("aria-selected", "true");
      expect(search()).toHaveAttribute("aria-activedescendant", option("trailing")?.id);
      fireEvent.keyDown(search(), { key: "ArrowUp" });
      fireEvent.keyDown(search(), { key: "ArrowUp" });
      expect(option("docker")).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(search(), { key: "Home" });
      fireEvent.keyDown(search(), { key: "Enter" });
      expect(writes()).toEqual([["ssh_write", { sessionId: "s1", data: "uptime" }]]);
    });
  });

  describe("pasting", () => {
    it("sends the command to the active pane with no newline, then closes", async () => {
      liveTerminal("s1");
      activate("s1");
      await openPalette();
      fireEvent.keyDown(search(), { key: "Enter" });
      expect(writes()).toEqual([["ssh_write", { sessionId: "s1", data: "uptime" }]]);
      expect(paletteOpen()).toBe(false);
    });

    it("pastes on a click too", async () => {
      liveTerminal("s1");
      activate("s1");
      await openPalette();
      fireEvent.click(option("uptime")!);
      expect(writes()).toEqual([["ssh_write", { sessionId: "s1", data: "uptime" }]]);
    });

    it("goes to the pane that last had focus in a split", async () => {
      liveTerminal("s1");
      const second = liveTerminal("s2");
      activate("s1", "s2");
      act(() => second.textarea.focus());
      await openPalette();
      fireEvent.keyDown(search(), { key: "Enter" });
      expect(writes()[0][1]).toEqual({ sessionId: "s2", data: "uptime" });
    });

    it("gives the keyboard back to that pane, ready for the user's Enter", async () => {
      const { focus } = liveTerminal("s1");
      activate("s1");
      await openPalette();
      fireEvent.keyDown(search(), { key: "Enter" });
      await waitFor(() => expect(focus).toHaveBeenCalledOnce());
    });

    it("drops a newline saved at the end of the snippet, so it does not run", async () => {
      liveTerminal("s1");
      activate("s1");
      await openPalette();
      fireEvent.click(option("trailing")!);
      expect(writes()[0][1]).toEqual({ sessionId: "s1", data: "df -h" });
    });

    it("pastes other tools' templates and unclosed braces as written", async () => {
      liveTerminal("s1");
      activate("s1");
      await openPalette();
      fireEvent.click(option("docker")!);
      expect(writes()[0][1]).toEqual({ sessionId: "s1", data: docker.command });
      expect(variable(".Names")).toBeNull();
    });

    it("closes on Escape without pasting and does not force focus onto the pane", async () => {
      // Its own session id: the previous test's deferred focus may still land on "s1".
      const { focus } = liveTerminal("s2");
      activate("s2");
      await openPalette();
      fireEvent.keyDown(search(), { key: "Escape" });
      await waitFor(() => expect(paletteOpen()).toBe(false));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(writes()).toEqual([]);
      expect(focus).not.toHaveBeenCalled();
    });

    it("stays on the terminal view it found", async () => {
      useViewStore.setState({ view: "terminals" });
      liveTerminal("s1");
      activate("s1");
      await openPalette();
      fireEvent.keyDown(search(), { key: "Enter" });
      expect(useViewStore.getState().view).toBe("terminals");
    });
  });

  describe("with no terminal", () => {
    it("explains it up front", async () => {
      await openPalette();
      expect(screen.getByTestId("snippet-palette-error")).toHaveTextContent(NO_TERMINAL_MESSAGE);
    });

    it("explains it when every pane of the tab failed", async () => {
      activate("failed");
      await openPalette();
      expect(screen.getByTestId("snippet-palette-error")).toHaveTextContent(NO_TERMINAL_MESSAGE);
    });

    it("stays open and sends nothing when a snippet is chosen", async () => {
      await openPalette();
      fireEvent.keyDown(search(), { key: "Enter" });
      expect(writes()).toEqual([]);
      expect(paletteOpen()).toBe(true);
      expect(screen.getByTestId("snippet-palette-error")).toHaveTextContent(NO_TERMINAL_MESSAGE);
    });

    it("does not ask for values it could not use", async () => {
      await openPalette();
      fireEvent.click(option("greet")!);
      expect(variable("who")).toBeNull();
      expect(screen.getByTestId("snippet-palette-error")).toHaveTextContent(NO_TERMINAL_MESSAGE);
    });
  });

  describe("snippets with several lines", () => {
    it("refuses them when the program did not ask for bracketed paste", async () => {
      liveTerminal("s1");
      activate("s1");
      await openPalette();
      fireEvent.click(option("two-lines")!);
      expect(writes()).toEqual([]);
      expect(paletteOpen()).toBe(true);
      expect(screen.getByTestId("snippet-palette-error")).toHaveTextContent(SEVERAL_LINES_MESSAGE);
    });

    it("refuses before asking for values", async () => {
      liveTerminal("s1");
      activate("s1");
      await openPalette();
      fireEvent.click(option("lines-var")!);
      expect(variable("dir")).toBeNull();
      expect(screen.getByTestId("snippet-palette-error")).toHaveTextContent(SEVERAL_LINES_MESSAGE);
    });

    it("drops the refusal when the search changes", async () => {
      liveTerminal("s1");
      activate("s1");
      await openPalette();
      fireEvent.click(option("two-lines")!);
      fireEvent.change(search(), { target: { value: "up" } });
      expect(screen.queryByTestId("snippet-palette-error")).not.toBeInTheDocument();
    });

    it("drops the refusal when another snippet is chosen", async () => {
      liveTerminal("s1");
      activate("s1");
      await openPalette();
      fireEvent.click(option("two-lines")!);
      fireEvent.click(option("greet")!);
      expect(variable("who")).toBeInTheDocument();
      expect(screen.queryByTestId("snippet-palette-error")).not.toBeInTheDocument();
    });

    it("sends them as a bracketed paste when the program asked for one", async () => {
      liveTerminal("s1", true);
      activate("s1");
      await openPalette();
      fireEvent.click(option("two-lines")!);
      expect(writes()).toEqual([
        ["ssh_write", { sessionId: "s1", data: "\x1b[200~cd /tmp\rls\x1b[201~" }],
      ]);
      expect(paletteOpen()).toBe(false);
    });
  });

  describe("variables", () => {
    async function pick(name: string) {
      liveTerminal("s1");
      activate("s1");
      await openPalette();
      fireEvent.click(option(name)!);
    }
    const type = (name: string, value: string) =>
      fireEvent.change(variable(name)!, { target: { value } });
    const submit = () => fireEvent.submit(screen.getByTestId("snippet-variables-form"));

    it("asks for a repeated variable once, sends nothing yet, and focuses the first", async () => {
      await pick("greet");
      expect(screen.getAllByTestId("snippet-variable").map((el) => el.dataset.name)).toEqual([
        "who",
        "place",
      ]);
      expect(variable("who")).toHaveFocus();
      expect(writes()).toEqual([]);
    });

    it("fills every occurrence and pastes with no newline", async () => {
      await pick("greet");
      type("who", "ann");
      type("place", "paris");
      submit();
      expect(writes()).toEqual([
        ["ssh_write", { sessionId: "s1", data: "echo ann ann from paris" }],
      ]);
      expect(paletteOpen()).toBe(false);
    });

    it("previews what will be pasted as values come in", async () => {
      await pick("greet");
      const preview = screen.getByTestId("snippet-variables-preview");
      expect(preview).toHaveTextContent("echo {{who}} {{ who }} from {{place}}");
      type("who", "ann");
      expect(preview).toHaveTextContent("echo ann ann from {{place}}");
    });

    it("requires every value and says which is missing", async () => {
      await pick("greet");
      type("who", "ann");
      submit();
      expect(writes()).toEqual([]);
      expect(paletteOpen()).toBe(true);
      expect(variable("place")).toHaveAttribute("aria-invalid", "true");
      expect(variable("who")).not.toHaveAttribute("aria-invalid");
      expect(screen.getByRole("alert")).toHaveTextContent("Enter a value");
      type("place", "x");
      expect(variable("place")).not.toHaveAttribute("aria-invalid");
    });

    it("keeps values as typed: a space counts and nothing is quoted", async () => {
      await pick("greet");
      type("who", " ");
      type("place", "a; b");
      submit();
      expect(writes()[0][1]).toEqual({ sessionId: "s1", data: "echo     from a; b" });
    });

    it("handles names that exist on Object.prototype", async () => {
      await pick("proto");
      expect(variable("constructor")).toHaveValue("");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      submit();
      expect(screen.getAllByRole("alert")).toHaveLength(2);
      expect(writes()).toEqual([]);
      type("constructor", "c");
      type("__proto__", "p");
      submit();
      expect(writes()[0][1]).toEqual({ sessionId: "s1", data: "echo c p" });
    });

    it("goes back to the list with the search kept", async () => {
      liveTerminal("s1");
      activate("s1");
      await openPalette();
      fireEvent.change(search(), { target: { value: "greet" } });
      fireEvent.click(option("greet")!);
      fireEvent.click(screen.getByTestId("snippet-variables-back"));
      expect(search()).toHaveValue("greet");
      expect(option("greet")).toBeInTheDocument();
      expect(writes()).toEqual([]);
    });

    it("keeps the values when the pane went away meanwhile", async () => {
      await pick("greet");
      type("who", "ann");
      type("place", "paris");
      unregisterTerminal("s1");
      submit();
      expect(paletteOpen()).toBe(true);
      expect(writes()).toEqual([]);
      expect(screen.getByTestId("snippet-palette-error")).toHaveTextContent(NO_TERMINAL_MESSAGE);
      expect(variable("who")).toHaveValue("ann");
    });
  });
});
