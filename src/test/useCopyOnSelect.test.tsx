import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useCopyOnSelect } from "@/hooks/useCopyOnSelect";
import { useSettingsStore } from "@/store/useSettingsStore";

function Page() {
  useCopyOnSelect();
  return (
    <>
      <p data-testid="text">db.example.com</p>
      <p data-testid="blank">{"   "}</p>
      <input data-testid="input" defaultValue="typed" />
      <input data-testid="password" type="password" defaultValue="hunter2" />
      <textarea data-testid="textarea" defaultValue="typed" />
      <div data-testid="editable" contentEditable suppressContentEditableWarning>
        <span>typed</span>
      </div>
      <div className="xterm" data-testid="xterm">
        <span>terminal text</span>
      </div>
    </>
  );
}

describe("useCopyOnSelect", () => {
  const writeText = vi.fn();
  const element = (testId: string) => document.querySelector(`[data-testid="${testId}"]`)!;

  /** Select an element's contents, as a drag does, and end the drag on it. */
  function select(testId: string, finish: (el: Element) => void = (el) => fireEvent.pointerUp(el)) {
    const el = element(testId);
    window.getSelection()?.selectAllChildren(el);
    finish(el);
  }

  /** A click that clears the selection, as a real one does. */
  function clearSelection() {
    window.getSelection()?.removeAllRanges();
    fireEvent.pointerUp(document.body);
  }

  const setAutoCopy = (auto_copy_selection: boolean) =>
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, auto_copy_selection } }));

  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    setAutoCopy(true);
    render(<Page />);
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    cleanup();
    setAutoCopy(false);
  });

  it("copies a finished selection when the pointer comes up", () => {
    select("text");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("db.example.com");
  });

  it("copies a selection made with the keyboard when the key comes up", () => {
    select("text", (el) => fireEvent.keyUp(el, { key: "Shift" }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("db.example.com");
  });

  it("does not copy on the selection changing, before it is finished", () => {
    select("text", () => fireEvent(document, new Event("selectionchange")));
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not put back a selection that has not changed, over what was copied since", () => {
    select("text");
    writeText.mockClear();
    fireEvent.keyUp(document.body, { key: "Tab" });
    fireEvent.pointerUp(document.body);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not copy with the setting off, and reads it at each selection", () => {
    setAutoCopy(false);
    select("text");
    expect(writeText).not.toHaveBeenCalled();

    setAutoCopy(true);
    clearSelection();
    select("text");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("db.example.com");
  });

  it("copies the same text again once it has been deselected in between", () => {
    select("text");
    clearSelection();
    select("text");
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it.each(["input", "password", "textarea"])(
    "does not copy with the focus in a field, %s, whatever the selection says",
    (testId) => {
      (element(testId) as HTMLElement).focus();
      select("text", () => fireEvent.pointerUp(document.body));
      expect(writeText).not.toHaveBeenCalled();
    },
  );

  it.each(["input", "password", "textarea"])("does not copy when a drag ends on a field, %s", (testId) => {
    select("text", () => fireEvent.pointerUp(element(testId)));
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not copy from a contenteditable", () => {
    select("editable", () => fireEvent.pointerUp(document.body));
    expect(writeText).not.toHaveBeenCalled();
  });

  it("leaves a selection inside a terminal to the terminal's own extension", () => {
    select("xterm", () => fireEvent.pointerUp(document.body));
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not copy an empty or a blank selection", () => {
    select("text", () => {});
    clearSelection();
    select("blank");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not copy the word a right-click selects", () => {
    select("text", (el) => fireEvent.pointerUp(el, { button: 2 }));
    expect(writeText).not.toHaveBeenCalled();
  });

  it("handles the clipboard refusing the write", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    // Not a `vi.fn`, which handles the rejection itself to record it.
    const refuse = () => Promise.reject(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: refuse } });
    select("text");
    await new Promise((resolve) => setTimeout(resolve));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
