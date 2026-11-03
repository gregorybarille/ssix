import { describe, expect, it } from "vitest";
import { clipboardKeyAction } from "@/components/terminal/clipboardKeys";

describe("clipboardKeyAction", () => {
  const key = (key: string, modifiers: Partial<KeyboardEvent> = {}) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers,
  });
  const CTRL = { ctrlKey: true };
  const CTRL_SHIFT = { ctrlKey: true, shiftKey: true };
  const CMD = { metaKey: true };

  it.each(["linux", "windows"] as const)("on %s takes Ctrl+Shift+C and Ctrl+Shift+V only", (platform) => {
    expect(clipboardKeyAction(key("C", CTRL_SHIFT), platform)).toBe("copy");
    expect(clipboardKeyAction(key("V", CTRL_SHIFT), platform)).toBe("paste");
    expect(clipboardKeyAction(key("c", CTRL), platform)).toBeNull();
    expect(clipboardKeyAction(key("v", CTRL), platform)).toBeNull();
    expect(clipboardKeyAction(key("c", CMD), platform)).toBeNull();
  });

  it("on macOS takes Cmd+C and Cmd+V only", () => {
    expect(clipboardKeyAction(key("c", CMD), "macos")).toBe("copy");
    expect(clipboardKeyAction(key("v", CMD), "macos")).toBe("paste");
    expect(clipboardKeyAction(key("c", CTRL), "macos")).toBeNull();
    expect(clipboardKeyAction(key("v", CTRL), "macos")).toBeNull();
    expect(clipboardKeyAction(key("C", CTRL_SHIFT), "macos")).toBeNull();
    expect(clipboardKeyAction(key("c", { ...CMD, shiftKey: true }), "macos")).toBeNull();
  });

  it("leaves other keys and Alt combinations alone", () => {
    expect(clipboardKeyAction(key("f", CTRL_SHIFT), "linux")).toBeNull();
    expect(clipboardKeyAction(key("c", { ...CTRL_SHIFT, altKey: true }), "linux")).toBeNull();
    expect(clipboardKeyAction(key("c", { ...CMD, altKey: true }), "macos")).toBeNull();
  });
});
