import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(__dirname, "..", rel), "utf8");

describe("App shell structure", () => {
  const app = read("App.tsx");
  const toast = read("components/ScreenshotToast.tsx");

  it("contains settings scrolling inside the settings view wrapper", () => {
    const start = app.indexOf('view === "settings"');
    const end = app.indexOf("<ScreenshotToast />", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const slice = app.slice(start, end);
    expect(slice).toMatch(/overflow-y-auto overscroll-contain/);
  });

  it("keeps the terminals mounted across views, hidden rather than removed", () => {
    expect(app).toMatch(/\{tabs\.length > 0 && \(\s*<TerminalTabs/);
    expect(app).toContain("hidden={!terminalsShowing}");
    expect(app).toContain('const terminalsShowing = view === "terminals"');
    const terminals = app.indexOf("<TerminalTabs");
    const otherViews = app.indexOf("{!terminalsShowing && (");
    expect(otherViews).toBeGreaterThan(terminals);
    expect(app.lastIndexOf('view === "settings"')).toBeGreaterThan(otherViews);
  });

  it("takes a screenshot from a shortcut, with no window menu and no emoji", () => {
    expect(app).not.toContain("📸");
    expect(toast).not.toContain("📸");

    expect(app).not.toContain("Take screenshot");
    expect(app).not.toContain("ssix:contextmenu");
    const binding = app.slice(app.indexOf('"mod+shift+p"'), app.indexOf('"mod+shift+p"') + 120);
    expect(binding).toContain("captureScreenshot()");
    expect(binding).toContain("allowInTypingSurface: true");
  });

  it("marks the screenshot toast as excluded from future captures", () => {
    expect(toast).toContain('data-screenshot-exclude="true"');
  });

  it("routes the close-terminal confirm by a typed target, not a string sentinel", () => {
    expect(app).not.toContain("__tab__");
    expect(app).toMatch(/target\.kind === "tab"/);
  });
});
