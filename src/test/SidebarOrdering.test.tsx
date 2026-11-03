import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "@/components/Sidebar";
import { useSettingsStore } from "@/store/useSettingsStore";
import { withPointerCoordinates } from "./pointerEvents";

const TOP = ["nav-connections", "nav-files", "nav-snippets", "nav-forwards", "nav-scripts"];
const BOTTOM = ["nav-credentials", "nav-logs", "nav-git-sync"];
const HOLD = 350;

const initialSettings = useSettingsStore.getState().settings;
const initialSave = useSettingsStore.getState().saveSettings;
const save = vi.fn();

const shown = (group: "top" | "bottom") =>
  within(screen.getByTestId(`sidebar-${group}`))
    .getAllByRole("button")
    .map((button) => button.dataset.testid);

const storeOrder = (top: string[], bottom: string[]) =>
  act(() =>
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, sidebar_top: top, sidebar_bottom: bottom },
    })),
  );

const stored = () => {
  const { sidebar_top, sidebar_bottom } = useSettingsStore.getState().settings;
  return [sidebar_top, sidebar_bottom];
};

const item = (name: string) => screen.getByRole("menuitem", { name }) as HTMLButtonElement;

beforeEach(() => {
  save.mockReset();
  save.mockImplementation(async (settings) => {
    useSettingsStore.setState({ settings });
  });
  useSettingsStore.setState({
    settings: { ...initialSettings, sidebar_top: [], sidebar_bottom: [] },
    saveSettings: save,
  });
});

afterEach(() => {
  useSettingsStore.setState({ settings: initialSettings, saveSettings: initialSave });
});

describe("Sidebar groups", () => {
  it("shows the default order, with Settings left to the title bar", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    expect(shown("top")).toEqual(TOP);
    expect(shown("bottom")).toEqual(BOTTOM);
    expect(screen.queryByTestId("nav-settings")).toBeNull();
  });

  it("shows a stored order, and Terminals outside both groups", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} terminalCount={1} />);
    storeOrder(["logs", "connections"], ["scripts"]);
    expect(shown("top")).toEqual([
      "nav-logs",
      "nav-connections",
      "nav-files",
      "nav-snippets",
      "nav-forwards",
    ]);
    expect(shown("bottom")).toEqual(["nav-scripts", "nav-credentials", "nav-git-sync"]);
    const top = screen.getByTestId("sidebar-top");
    const terminals = screen.getByTestId("nav-terminals");
    const bottom = screen.getByTestId("sidebar-bottom");
    expect(top.compareDocumentPosition(terminals)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(terminals.compareDocumentPosition(bottom)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe("Sidebar order menu", () => {
  const openMenu = (testId: string) => fireEvent.contextMenu(screen.getByTestId(testId));

  it("moves up inside a group, saves and says so", async () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    openMenu("nav-files");
    await userEvent.click(item("Move up"));
    await waitFor(() =>
      expect(shown("top")).toEqual(["nav-files", "nav-connections", ...TOP.slice(2)]),
    );
    expect(save).toHaveBeenCalledOnce();
    expect(stored()).toEqual([
      ["files", "connections", "snippets", "forwards", "scripts"],
      ["credentials", "logs", "git_sync"],
    ]);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Files moved to place 1 of 5 in the top group",
    );
  });

  it("crosses from the end of the top group into the bottom one", async () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    openMenu("nav-scripts");
    await userEvent.click(item("Move down"));
    await waitFor(() => expect(shown("bottom")).toEqual(["nav-scripts", ...BOTTOM]));
    expect(shown("top")).toEqual(TOP.slice(0, -1));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Scripts moved to place 1 of 4 in the bottom group",
    );
  });

  it("disables what cannot happen", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    openMenu("nav-connections");
    expect(item("Move up")).toBeDisabled();
    expect(item("Move down")).toBeEnabled();
    expect(item("Reset order")).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    openMenu("nav-git-sync");
    expect(item("Move up")).toBeEnabled();
    expect(item("Move down")).toBeDisabled();
  });

  it("resets to the default, storing nothing", async () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    storeOrder(["logs"], ["connections"]);
    openMenu("nav-logs");
    expect(item("Reset order")).toBeEnabled();
    await userEvent.click(item("Reset order"));
    await waitFor(() => expect(shown("top")).toEqual(TOP));
    expect(shown("bottom")).toEqual(BOTTOM);
    expect(stored()).toEqual([[], []]);
    expect(screen.getByRole("status")).toHaveTextContent("Sidebar order reset");
  });

  it("stores nothing when a move lands back on the default", async () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    openMenu("nav-files");
    await userEvent.click(item("Move up"));
    await waitFor(() => expect(shown("top")[0]).toBe("nav-files"));
    openMenu("nav-files");
    await userEvent.click(item("Move down"));
    await waitFor(() => expect(shown("top")).toEqual(TOP));
    expect(stored()).toEqual([[], []]);
  });

  it("opens from the keyboard and keeps focus on a button that changed group", async () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    const button = screen.getByTestId("nav-scripts");
    button.focus();
    fireEvent.keyDown(button, { key: "F10", shiftKey: true });
    await userEvent.click(item("Move down"));
    await waitFor(() => expect(shown("bottom")[0]).toBe("nav-scripts"));
    await waitFor(() => expect(screen.getByTestId("nav-scripts")).toHaveFocus());
  });

  it("leaves focus where it was after a right click from elsewhere", async () => {
    render(
      <>
        <input aria-label="elsewhere" />
        <Sidebar active="connections" onNavigate={vi.fn()} />
      </>,
    );
    const elsewhere = screen.getByLabelText("elsewhere");
    elsewhere.focus();
    openMenu("nav-scripts");
    fireEvent.click(item("Move down"));
    await waitFor(() => expect(shown("bottom")[0]).toBe("nav-scripts"));
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(screen.getByTestId("nav-scripts")).not.toHaveFocus();
  });

  it("has no order menu on Terminals, which does not move", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} terminalCount={1} />);
    openMenu("nav-terminals");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("goes back to the order it had when a save fails", async () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    save.mockImplementation(async () => {
      throw new Error("disk full");
    });
    openMenu("nav-files");
    await userEvent.click(item("Move up"));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(shown("top")).toEqual(TOP);
  });
});

describe("Sidebar long press and drag", () => {
  withPointerCoordinates();

  /** jsdom lays nothing out: each button 40 high, the top group at 0, the bottom at 500. */
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const rect = (top: number, bottom: number, right = 64) =>
        ({ top, bottom, left: 0, right, width: right, height: bottom - top }) as DOMRect;
      const element = this as HTMLElement;
      const place = (group: Element) => {
        const buttons = [...group.querySelectorAll("button")];
        return { start: group.getAttribute("data-testid") === "sidebar-top" ? 0 : 500, buttons };
      };
      if (element.dataset.testid?.startsWith("sidebar-")) {
        const { start, buttons } = place(element);
        return rect(start, start + Math.max(buttons.length, 1) * 48);
      }
      const group = element.closest('[data-testid^="sidebar-"]');
      if (group && group !== element && element.tagName === "BUTTON") {
        const { start, buttons } = place(group);
        const top = start + buttons.indexOf(element as HTMLButtonElement) * 48;
        return rect(top, top + 40);
      }
      return rect(0, 800);
    });
  });
  afterEach(() => {
    // A drag's release listens for its click until the next timer: let that end
    // here, or the next test's click is the one it eats.
    act(() => vi.runOnlyPendingTimers());
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const press = (testId: string, clientY = 20) =>
    fireEvent.pointerDown(screen.getByTestId(testId), { button: 0, clientX: 30, clientY });
  const hold = () => act(() => vi.advanceTimersByTime(HOLD));
  const moveTo = (clientY: number, clientX = 30) =>
    fireEvent.pointerMove(window, { clientX, clientY });
  const release = (clientY: number, clientX = 30) =>
    fireEvent.pointerUp(window, { clientX, clientY });
  const chip = () => screen.queryByTestId("sidebar-drag-chip");

  it("moves inside a group, and the click of the release opens nothing", () => {
    const onNavigate = vi.fn();
    render(<Sidebar active="connections" onNavigate={onNavigate} />);
    press("nav-scripts", 212);
    hold();
    expect(screen.getByTestId("nav-scripts")).toHaveAttribute("data-lifted", "true");
    moveTo(100);
    expect(chip()).toHaveTextContent("Scripts");
    expect(screen.getByTestId("nav-snippets")).toHaveAttribute("data-drop-line", "before");
    release(70);
    // Scripts in front of Snippets: the centres of the rest are 20, 68, 116, 164.
    expect(shown("top")).toEqual([
      "nav-connections",
      "nav-files",
      "nav-scripts",
      "nav-snippets",
      "nav-forwards",
    ]);
    fireEvent.click(screen.getByTestId("nav-scripts"));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(chip()).toBeNull();
    expect(save).toHaveBeenCalledOnce();
  });

  it("moves between groups, and marks the end of a group", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    press("nav-files", 68);
    hold();
    moveTo(700);
    expect(screen.getByTestId("nav-git-sync")).toHaveAttribute("data-drop-line", "after");
    release(700);
    expect(shown("bottom")).toEqual([...BOTTOM, "nav-files"]);
    expect(stored()[1]).toEqual(["credentials", "logs", "git_sync", "files"]);
  });

  it("gives an emptied group somewhere to drop", () => {
    storeOrder(
      ["connections"],
      ["files", "snippets", "forwards", "scripts", "credentials", "logs", "git_sync"],
    );
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    press("nav-connections");
    hold();
    moveTo(700);
    release(700);
    expect(within(screen.getByTestId("sidebar-top")).queryAllByRole("button")).toEqual([]);
    expect(screen.queryByTestId("sidebar-drop-zone-top")).toBeNull();

    press("nav-files", 548);
    hold();
    moveTo(530);
    expect(screen.getByTestId("sidebar-drop-zone-top")).toBeInTheDocument();
    release(10);
    expect(shown("top")).toEqual(["nav-files"]);
    expect(screen.queryByTestId("sidebar-drop-zone-top")).toBeNull();
  });

  it("gives up on a press that moves before the hold, leaving the click alone", () => {
    const onNavigate = vi.fn();
    render(<Sidebar active="connections" onNavigate={onNavigate} />);
    press("nav-scripts", 212);
    act(() => vi.advanceTimersByTime(HOLD - 1));
    moveTo(100);
    hold();
    moveTo(50);
    expect(chip()).toBeNull();
    expect(screen.getByTestId("nav-scripts")).not.toHaveAttribute("data-lifted");
    release(50);
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("nav-scripts"));
    expect(onNavigate).toHaveBeenCalledWith("scripts");
  });

  it("treats a hold released without moving as a click", () => {
    const onNavigate = vi.fn();
    render(<Sidebar active="connections" onNavigate={onNavigate} />);
    press("nav-scripts", 212);
    hold();
    moveTo(214);
    release(214);
    expect(chip()).toBeNull();
    expect(screen.getByTestId("nav-scripts")).not.toHaveAttribute("data-lifted");
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("nav-scripts"));
    expect(onNavigate).toHaveBeenCalledWith("scripts");
  });

  it("changes nothing when let go where it was, or outside the sidebar", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    press("nav-files", 68);
    hold();
    moveTo(60);
    moveTo(68);
    release(68);
    expect(save).not.toHaveBeenCalled();

    press("nav-files", 68);
    hold();
    moveTo(20, 400);
    expect(chip()).toBeInTheDocument();
    expect(screen.getByTestId("nav-connections")).not.toHaveAttribute("data-drop-line");
    release(20, 400);
    expect(save).not.toHaveBeenCalled();
    expect(shown("top")).toEqual(TOP);
  });

  it("cancels on Escape, during the drag or the hold, and swallows the release's click", () => {
    const onNavigate = vi.fn();
    render(<Sidebar active="connections" onNavigate={onNavigate} />);
    const escape = () => fireEvent.keyDown(window, { key: "Escape" });

    press("nav-scripts", 212);
    hold();
    moveTo(100);
    escape();
    expect(chip()).toBeNull();
    release(70);
    fireEvent.click(screen.getByTestId("nav-scripts"));
    act(() => vi.runOnlyPendingTimers());

    press("nav-scripts", 212);
    hold();
    escape();
    expect(screen.getByTestId("nav-scripts")).not.toHaveAttribute("data-lifted");
    release(212);
    fireEvent.click(screen.getByTestId("nav-scripts"));
    act(() => vi.runOnlyPendingTimers());

    expect(onNavigate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(shown("top")).toEqual(TOP);
  });

  it("does not start on a right press or a modified one", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    fireEvent.pointerDown(screen.getByTestId("nav-scripts"), { button: 2, clientY: 212 });
    hold();
    moveTo(100);
    expect(chip()).toBeNull();
    fireEvent.pointerDown(screen.getByTestId("nav-scripts"), {
      button: 0,
      ctrlKey: true,
      clientY: 212,
    });
    hold();
    moveTo(100);
    expect(chip()).toBeNull();
  });

  it("does not drag Terminals", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} terminalCount={1} />);
    press("nav-terminals", 300);
    hold();
    moveTo(100);
    expect(chip()).toBeNull();
  });
});
