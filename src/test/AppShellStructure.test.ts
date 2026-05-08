import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("App.tsx shell structure", () => {
  const src = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");

  it("contains settings scrolling inside the settings view wrapper", () => {
    const start = src.indexOf('view === "settings"');
    const end = src.indexOf("{dialogs.contextMenu &&", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const slice = src.slice(start, end);
    expect(slice).toMatch(/overflow-y-auto overscroll-contain/);
  });

  it("renders the screenshot affordances without emoji or a menu icon", () => {
    expect(src).not.toContain("📸");

    const itemStart = src.indexOf('label: "Take screenshot"');
    expect(itemStart).toBeGreaterThan(-1);
    const itemSlice = src.slice(itemStart, itemStart + 160);
    expect(itemSlice).not.toMatch(/icon\s*:/);
  });

  it("marks the screenshot toast as excluded from future captures", () => {
    expect(src).toContain('data-screenshot-exclude="true"');
  });
});
