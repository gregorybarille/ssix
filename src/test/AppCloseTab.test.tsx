import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import App from "@/App";
import { useDialogsStore } from "@/store/useDialogsStore";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import { useViewStore } from "@/store/useViewStore";
import type { Connection } from "@/types";

vi.mock("@/components/Terminal", () => ({
  Terminal: ({ sessionId }: { sessionId: string }) => <div data-testid={`terminal-${sessionId}`} />,
}));
vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: () => <div role="separator" />,
}));
// Never settles: the stores stay on their defaults.
vi.mock("@/lib/tauri", () => ({ invoke: () => new Promise(() => {}) }));

const conn = { id: "c1", name: "web", host: "h", port: 22, type: "direct" } as Connection;

describe("closing a terminal tab", () => {
  it("closes a tab still connecting without asking, as its pane would", () => {
    useTerminalsStore.setState({
      tabs: [
        {
          id: "tab",
          mode: "single",
          panes: [{ sessionId: "failed-c1-1", connectionName: "web", connection: conn, retrying: true }],
        },
      ],
      activeTabId: "tab",
    });
    useViewStore.setState({ view: "terminals" });
    render(<App />);

    act(() => fireEvent.click(screen.getByTestId("close-tab-tab")));

    expect(useDialogsStore.getState().confirmClosePane).toBeNull();
  });
});
