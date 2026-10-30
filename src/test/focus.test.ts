import { describe, it, expect } from "vitest";
import { isTextInput } from "@/lib/focus";

describe("isTextInput", () => {
  it("recognises text-entry elements and nothing else", () => {
    const text = document.createElement("input");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const area = document.createElement("textarea");
    const button = document.createElement("button");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isTextInput(text)).toBe(true);
    expect(isTextInput(area)).toBe(true);
    expect(isTextInput(editable)).toBe(true);
    expect(isTextInput(checkbox)).toBe(false);
    expect(isTextInput(button)).toBe(false);
    expect(isTextInput(null)).toBe(false);
    expect(isTextInput(document.body)).toBe(false);
  });
});
