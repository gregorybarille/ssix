import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import App from "@/App";
import type { ForwardSession } from "@/components/PortForwardsView";
import { usePortForwardsStore } from "@/store/usePortForwardsStore";
import { useSettingsStore } from "@/store/useSettingsStore";

// A child of App that takes the count, and is not memoised: its renders are App's.
const sidebar = vi.hoisted(() => ({ renders: 0, forwardCount: -1 }));
vi.mock("@/components/Sidebar", () => ({
  Sidebar: ({ forwardCount }: { forwardCount: number }) => {
    sidebar.renders += 1;
    sidebar.forwardCount = forwardCount;
    return null;
  },
}));
// Never settles: the stores stay on their defaults.
vi.mock("@/lib/tauri", () => ({ invoke: () => new Promise(() => {}) }));

const forward = (sessionId: string, bytesSent = 0) =>
  ({ sessionId, connectionName: "f", connection: { id: sessionId }, bytesSent }) as ForwardSession;

describe("App renders", () => {
  it("re-renders for a change in the number of forwards, not for their traffic", () => {
    usePortForwardsStore.setState({ sessions: [forward("a")] });
    render(<App />);
    expect(sidebar.forwardCount).toBe(1);
    const rendered = sidebar.renders;

    act(() => usePortForwardsStore.setState({ sessions: [forward("a", 1024)] }));
    expect(sidebar.renders).toBe(rendered);

    act(() => usePortForwardsStore.setState({ sessions: [forward("a", 1024), forward("b")] }));
    expect(sidebar.forwardCount).toBe(2);
  });

  it("copies a selection anywhere in the app when the setting is on", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, auto_copy_selection: true } }));
    render(<App />);

    const text = document.body.appendChild(document.createElement("p"));
    text.textContent = "db.example.com";
    window.getSelection()?.selectAllChildren(text);
    fireEvent.pointerUp(text);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("db.example.com");

    text.remove();
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, auto_copy_selection: false } }));
  });
});
