import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import App from "@/App";
import type { ForwardSession } from "@/components/PortForwardsView";
import { usePortForwardsStore } from "@/store/usePortForwardsStore";

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
});
