import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useGlobalShortcuts,
  isTypingSurface,
  blockedByTypingSurface,
} from "@/hooks/useGlobalShortcuts";

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
