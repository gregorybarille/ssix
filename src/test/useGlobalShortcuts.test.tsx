import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useGlobalShortcuts,
  isTypingSurface,
  blockedByTypingSurface,
  SHORTCUTS,
  FIND_COMBO,
  findCombo,
  TABLE_SHORTCUTS,
} from "@/hooks/useGlobalShortcuts";
import { useDialogsStore } from "@/store/useDialogsStore";
import { useTerminalSearchStore } from "@/store/useTerminalSearchStore";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import { useViewStore } from "@/store/useViewStore";

// Mirror the same platform detection used by the hook so tests are
// platform-independent: on macOS jsdom/CI the mod key is Meta, elsewhere Ctrl.
const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || "");
const MOD = isMac ? "metaKey" : "ctrlKey";

function dispatch(opts: Partial<KeyboardEventInit & { key: string; target?: HTMLElement }>) {
  const { target, ...init } = opts;
  const event = new KeyboardEvent("keydown", {
    key: "k",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (target) {
    Object.defineProperty(event, "target", { value: target });
    target.dispatchEvent(event);
  } else {
    window.dispatchEvent(event);
  }
  return event;
}

describe("SHORTCUTS", () => {
  it("binds each combo once, none of them the ones App.tsx handles itself", () => {
    const app = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
    const own = [...app.matchAll(/"(mod\+[^"]+)"\s*:/g)].map((match) => match[1]);
    expect(own).toEqual(expect.arrayContaining(["mod+n", "mod+w"]));
    const combos = [...SHORTCUTS.map((s) => s.combo), ...own];
    expect(combos.filter((combo, i) => combos.indexOf(combo) !== i)).toEqual([]);
  });

  it("takes Cmd+F on macOS and Ctrl+Shift+F elsewhere, clear of every other combo", () => {
    expect(findCombo(true)).toBe("mod+f");
    expect(findCombo(false)).toBe("mod+shift+f");
    const others = SHORTCUTS.map((s) => s.combo).filter((combo) => combo !== FIND_COMBO);
    expect(others).not.toContain(findCombo(true));
    expect(others).not.toContain(findCombo(false));
  });

  it("opens the find bar from inside a terminal, the one place it is any use", () => {
    const find = SHORTCUTS.find((s) => s.combo === FIND_COMBO);
    expect(find?.allowInTypingSurface).toBe(true);
    useViewStore.setState({ view: "terminals" });
    useTerminalSearchStore.setState({ sessionId: null });
    const open = vi.spyOn(useTerminalSearchStore.getState(), "open");
    find?.handler(new KeyboardEvent("keydown"));
    expect(open).toHaveBeenCalledOnce();
    open.mockRestore();
  });
});

describe("useGlobalShortcuts", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("fires the matching mod+key handler and prevents default", () => {
    const onK = vi.fn();
    renderHook(() => useGlobalShortcuts({ "mod+k": onK }));
    const evt = dispatch({ key: "k", [MOD]: true });
    expect(onK).toHaveBeenCalledTimes(1);
    expect(evt.defaultPrevented).toBe(true);
  });

  it("ignores keystrokes without the platform mod key", () => {
    const onK = vi.fn();
    renderHook(() => useGlobalShortcuts({ "mod+k": onK }));
    dispatch({ key: "k" });
    expect(onK).not.toHaveBeenCalled();
  });

  it("respects shift modifier", () => {
    const plain = vi.fn();
    const shifted = vi.fn();
    renderHook(() =>
      useGlobalShortcuts({ "mod+n": plain, "mod+shift+n": shifted }),
    );
    dispatch({ key: "n", [MOD]: true, shiftKey: true });
    expect(plain).not.toHaveBeenCalled();
    expect(shifted).toHaveBeenCalledTimes(1);
  });

  it("skips shortcuts when focus is in an input by default", () => {
    const onK = vi.fn();
    renderHook(() => useGlobalShortcuts({ "mod+k": onK }));
    const input = document.createElement("input");
    document.body.appendChild(input);
    dispatch({ key: "k", [MOD]: true, target: input });
    expect(onK).not.toHaveBeenCalled();
  });

  it("fires inside an input when allowInTypingSurface is set", () => {
    const handler = vi.fn();
    renderHook(() =>
      useGlobalShortcuts({ "mod+k": { handler, allowInTypingSurface: true } }),
    );
    const input = document.createElement("input");
    document.body.appendChild(input);
    dispatch({ key: "k", [MOD]: true, target: input });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("skips Ctrl shortcuts inside xterm but lets Cmd shortcuts through on macOS", () => {
    const onW = vi.fn();
    renderHook(() => useGlobalShortcuts({ "mod+w": onW }));
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    xterm.appendChild(helper);
    document.body.appendChild(xterm);
    dispatch({ key: "w", [MOD]: true, target: helper });
    // Cmd+W is never a readline binding, so on macOS the app shortcut
    // must work while the shell has focus. Ctrl+W elsewhere is
    // "delete word" in the shell and must pass through untouched.
    if (isMac) expect(onW).toHaveBeenCalledTimes(1);
    else expect(onW).not.toHaveBeenCalled();
  });

  it("blockedByTypingSurface honours allowInTypingSurface and the platform rule", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const ev = new KeyboardEvent("keydown", { key: "k", [MOD]: true });
    Object.defineProperty(ev, "target", { value: input });
    expect(blockedByTypingSurface(ev, { handler: vi.fn(), allowInTypingSurface: true })).toBe(false);
    expect(blockedByTypingSurface(ev, { handler: vi.fn() })).toBe(!isMac);
  });

  it("uses the latest map without re-registering the listener", () => {
    const first = vi.fn();
    const second = vi.fn();
    const add = vi.spyOn(window, "addEventListener");
    const { rerender } = renderHook(({ m }) => useGlobalShortcuts(m), {
      initialProps: { m: { "mod+k": first } },
    });
    const registered = add.mock.calls.filter((c) => c[0] === "keydown").length;
    rerender({ m: { "mod+k": second } });
    expect(add.mock.calls.filter((c) => c[0] === "keydown").length).toBe(registered);
    dispatch({ key: "k", [MOD]: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    add.mockRestore();
  });

  it("isTypingSurface returns true for contentEditable elements", () => {
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    document.body.appendChild(div);
    expect(isTypingSurface(div)).toBe(true);
  });

  it("ignores combos that mix Ctrl and Cmd to avoid swallowing readline shortcuts", () => {
    const onK = vi.fn();
    renderHook(() => useGlobalShortcuts({ "mod+k": onK }));
    // On any platform a Ctrl+Cmd combo is unusual; we don't want to claim it.
    dispatch({ key: "k", ctrlKey: true, metaKey: true });
    expect(onK).not.toHaveBeenCalled();
  });
});

describe("shortcut table", () => {
  it("has one row per combo, each described", () => {
    const combos = SHORTCUTS.map((s) => s.combo);
    expect(new Set(combos).size).toBe(combos.length);
    for (const shortcut of SHORTCUTS) expect(shortcut.description).not.toBe("");
  });

  it("mod+k opens the quick connect picker", () => {
    renderHook(() => useGlobalShortcuts(TABLE_SHORTCUTS));
    useDialogsStore.getState().setPickerOpen(false);
    dispatch({ key: "k", [MOD]: true });
    expect(useDialogsStore.getState().pickerOpen).toBe(true);
    useDialogsStore.getState().setPickerOpen(false);
  });

  it("mod+comma opens settings", () => {
    renderHook(() => useGlobalShortcuts(TABLE_SHORTCUTS));
    useViewStore.setState({ view: "connections", leaveGuard: null });
    dispatch({ key: ",", [MOD]: true });
    expect(useViewStore.getState().view).toBe("settings");
    useViewStore.setState({ view: "connections" });
  });

  it("mod+1 to mod+9 select the matching terminal tab", () => {
    const selectTabByIndex = vi.fn();
    const original = useTerminalsStore.getState().selectTabByIndex;
    useTerminalsStore.setState({ selectTabByIndex });
    renderHook(() => useGlobalShortcuts(TABLE_SHORTCUTS));
    dispatch({ key: "1", [MOD]: true });
    dispatch({ key: "9", [MOD]: true });
    expect(selectTabByIndex.mock.calls).toEqual([[0], [8]]);
    useTerminalsStore.setState({ selectTabByIndex: original });
  });

  it("lets a map passed to the hook override a table row", () => {
    const override = vi.fn();
    renderHook(() => useGlobalShortcuts({ ...TABLE_SHORTCUTS, "mod+k": override }));
    useDialogsStore.getState().setPickerOpen(false);
    dispatch({ key: "k", [MOD]: true });
    expect(override).toHaveBeenCalledTimes(1);
    expect(useDialogsStore.getState().pickerOpen).toBe(false);
  });
});
