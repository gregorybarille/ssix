import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("html-to-image", () => ({
  toPng: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

import { toPng } from "html-to-image";
import { invoke } from "@/lib/tauri";
import { formatScreenshotError, takeScreenshot } from "@/lib/screenshot";

describe("screenshot helpers", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="root">
        <main>app</main>
        <div data-screenshot-exclude="true">toast</div>
      </div>
    `;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("captures the app root and strips the data URL prefix before saving", async () => {
    vi.mocked(toPng).mockResolvedValue("data:image/png;base64,abc123");
    vi.mocked(invoke).mockResolvedValue("/tmp/shot.png");

    await expect(takeScreenshot()).resolves.toBe("/tmp/shot.png");

    expect(toPng).toHaveBeenCalledWith(
      document.getElementById("root"),
      expect.objectContaining({
        cacheBust: true,
        pixelRatio: window.devicePixelRatio || 1,
      }),
    );
    expect(invoke).toHaveBeenCalledWith("take_screenshot", {
      imageData: "abc123",
    });

    const filter = vi.mocked(toPng).mock.calls[0]?.[1]?.filter;
    expect(filter?.(document.querySelector("[data-screenshot-exclude='true']")!)).toBe(
      false,
    );
  });

  it("adds capture-phase context when rendering the DOM fails", async () => {
    vi.mocked(toPng).mockRejectedValue(new Error("canvas blew up"));

    await expect(takeScreenshot()).rejects.toThrow(
      "Unable to capture the window: canvas blew up",
    );
  });

  it("adds save-phase context when the backend write fails", async () => {
    vi.mocked(toPng).mockResolvedValue("data:image/png;base64,abc123");
    vi.mocked(invoke).mockRejectedValue(new Error("desktop is read-only"));

    await expect(takeScreenshot()).rejects.toThrow(
      "Unable to save the screenshot: desktop is read-only",
    );
  });

  it("rejects malformed renderer output before invoking the backend", async () => {
    vi.mocked(toPng).mockResolvedValue("not-a-data-url");

    await expect(takeScreenshot()).rejects.toThrow(
      "Unable to save the screenshot: Unexpected screenshot data format.",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("normalizes verbose error strings for UI display", () => {
    expect(formatScreenshotError(new Error("Error: disk full"))).toBe("disk full");
    expect(formatScreenshotError("  simple failure  ")).toBe("simple failure");
    expect(formatScreenshotError("x".repeat(170))).toHaveLength(160);
  });
});
