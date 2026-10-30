import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(__dirname, "..", rel), "utf8");

describe("App shell structure", () => {
  const app = read("App.tsx");
  const toast = read("components/ScreenshotToast.tsx");

  it("contains settings scrolling inside the settings view wrapper", () => {
    const start = app.indexOf('view === "settings"');
    const end = app.indexOf("{dialogs.contextMenu &&", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const slice = app.slice(start, end);
    expect(slice).toMatch(/overflow-y-auto overscroll-contain/);
  });

  it("renders the screenshot affordances without emoji or a menu icon", () => {
    expect(app).not.toContain("📸");
    expect(toast).not.toContain("📸");

    const itemStart = app.indexOf('label: "Take screenshot"');
    expect(itemStart).toBeGreaterThan(-1);
    const itemSlice = app.slice(itemStart, itemStart + 160);
    expect(itemSlice).not.toMatch(/icon\s*:/);
  });

  it("marks the screenshot toast as excluded from future captures", () => {
    expect(toast).toContain('data-screenshot-exclude="true"');
  });

  it("routes the close-terminal confirm by a typed target, not a string sentinel", () => {
    expect(app).not.toContain("__tab__");
    expect(app).toMatch(/target\.kind === "tab"/);
  });
});
