import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TitleBar } from "@/components/TitleBar";

type WindowMocks = {
  isMaximized: ReturnType<typeof vi.fn>;
  toggleMaximize: ReturnType<typeof vi.fn>;
  minimize: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onResized: ReturnType<typeof vi.fn>;
};

const win = (globalThis as unknown as { __windowMocks: WindowMocks })
  .__windowMocks;
let resizeListener: null | (() => void) = null;

describe("TitleBar maximize subscription (non-macOS)", () => {
  beforeEach(() => {
    resizeListener = null;
    win.isMaximized.mockReset();
    win.toggleMaximize.mockReset();
    win.onResized.mockReset();
    win.isMaximized.mockResolvedValue(false);
    win.toggleMaximize.mockResolvedValue(undefined);
    win.onResized.mockImplementation(async (cb: () => void) => {
      resizeListener = cb;
      return () => {
        resizeListener = null;
      };
    });
    // Force Windows platform branch. jsdom's navigator.userAgent is a
    // getter, so vi.spyOn is the reliable way to override it.
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Windows NT 10.0)",
    );
  });

  it("renders the Maximize button initially when the OS reports unmaximized", async () => {
    render(<TitleBar onSettings={() => {}} settingsActive={false} />);
    // The mount-time refresh queries isMaximized → false → label stays
    // "Maximize window".
    expect(
      await screen.findByRole("button", { name: /maximize window/i }),
    ).toBeInTheDocument();
  });

  it("renders the Restore button when the OS reports the window is already maximized on mount", async () => {
    win.isMaximized.mockResolvedValue(true);
    render(<TitleBar onSettings={() => {}} settingsActive={false} />);
    expect(
      await screen.findByRole("button", { name: /restore window/i }),
    ).toBeInTheDocument();
  });

  it("flips the icon label when the OS resizes the window externally", async () => {
    render(<TitleBar onSettings={() => {}} settingsActive={false} />);
    expect(
      await screen.findByRole("button", { name: /maximize window/i }),
    ).toBeInTheDocument();
    // Wait for the onResized subscription to land (it's async).
    await waitFor(() => expect(win.onResized).toHaveBeenCalled());
    // Pull the callback out of the spy's call history; this is more
    // robust than relying on the mockImplementation closure being
    // invoked by the dynamic import.
    const cb = win.onResized.mock.calls[0]?.[0] as (() => void) | undefined;
    expect(cb).toBeTypeOf("function");
    // Simulate the OS maximizing the window (e.g. Win+Up). The next
    // isMaximized() call should report true; the resize callback should
    // re-query and update the label without our toggleMaximize handler
    // ever firing.
    win.isMaximized.mockResolvedValue(true);
    await act(async () => {
      cb?.();
    });
    expect(
      await screen.findByRole("button", { name: /restore window/i }),
    ).toBeInTheDocument();
  });

  it("flips the icon label after a click on the Maximize button", async () => {
    const user = userEvent.setup();
    render(<TitleBar onSettings={() => {}} settingsActive={false} />);
    const btn = await screen.findByRole("button", { name: /maximize window/i });
    win.isMaximized.mockResolvedValue(true);
    await user.click(btn);
    expect(
      await screen.findByRole("button", { name: /restore window/i }),
    ).toBeInTheDocument();
  });

  it("unsubscribes from onResized on unmount", async () => {
    const unlisten = vi.fn();
    win.onResized.mockResolvedValue(unlisten);
    const { unmount } = render(
      <TitleBar onSettings={() => {}} settingsActive={false} />,
    );
    // Wait for subscribe() to register and resolve the unlisten.
    await waitFor(() => expect(win.onResized).toHaveBeenCalled());
    // Drain the microtask queue so the awaited unlisten lands in the
    // component's closure before we unmount.
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    expect(unlisten).toHaveBeenCalled();
  });
});
