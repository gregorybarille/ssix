import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useGlobalShortcuts, isTypingSurface } from "@/hooks/useGlobalShortcuts";

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
    const evt = dispatch({ key: "k", ctrlKey: true, metaKey: false });
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
    dispatch({ key: "n", ctrlKey: true, shiftKey: true });
    expect(plain).not.toHaveBeenCalled();
    expect(shifted).toHaveBeenCalledTimes(1);
  });

  it("skips shortcuts when focus is in an input by default", () => {
    const onK = vi.fn();
    renderHook(() => useGlobalShortcuts({ "mod+k": onK }));
    const input = document.createElement("input");
    document.body.appendChild(input);
    dispatch({ key: "k", ctrlKey: true, target: input });
    expect(onK).not.toHaveBeenCalled();
  });

  it("fires inside an input when allowInTypingSurface is set", () => {
    const handler = vi.fn();
    renderHook(() =>
      useGlobalShortcuts({ "mod+k": { handler, allowInTypingSurface: true } }),
    );
    const input = document.createElement("input");
    document.body.appendChild(input);
    dispatch({ key: "k", ctrlKey: true, target: input });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("skips shortcuts when focus is inside an xterm instance", () => {
    const onW = vi.fn();
    renderHook(() => useGlobalShortcuts({ "mod+w": onW }));
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    xterm.appendChild(helper);
    document.body.appendChild(xterm);
    dispatch({ key: "w", ctrlKey: true, target: helper });
    expect(onW).not.toHaveBeenCalled();
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
