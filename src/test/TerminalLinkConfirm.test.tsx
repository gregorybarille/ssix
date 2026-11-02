import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalLinkConfirm } from "@/components/terminal/TerminalLinkConfirm";
import { TerminalPaneOverlays } from "@/components/terminal/TerminalPaneOverlays";
import { useTerminalLinksStore } from "@/store/useTerminalLinksStore";

const mocks = vi.hoisted(() => ({ open: vi.fn(async () => {}) }));

vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
vi.mock("@/lib/platform", () => ({ detectPlatform: () => "linux" }));

const confirmUrl = (raw: string) =>
  act(() => useTerminalLinksStore.getState().setConfirming(new URL(raw)));

beforeEach(() => {
  mocks.open.mockClear();
  useTerminalLinksStore.setState({ hover: null, confirming: null });
});

describe("TerminalLinkConfirm", () => {
  it("shows nothing until a link asks", () => {
    render(<TerminalLinkConfirm />);
    expect(screen.queryByTestId("terminal-link-confirm")).toBeNull();
  });

  it("forgets the question when it goes away with the last tab", () => {
    const view = render(<TerminalLinkConfirm />);
    confirmUrl("https://real-target.example/path");
    view.unmount();

    render(<TerminalLinkConfirm />);
    expect(screen.queryByTestId("terminal-link-confirm")).toBeNull();
  });

  it("names the real host and the whole URL, not what the terminal showed", () => {
    render(<TerminalLinkConfirm />);
    confirmUrl("https://bank.example@evil.example/login");
    expect(screen.getByTestId("terminal-link-confirm-host")).toHaveTextContent(/^evil\.example$/);
    expect(screen.getByTestId("terminal-link-confirm-url")).toHaveTextContent(
      "https://bank.example@evil.example/login",
    );
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("opens the link on yes, and closes", async () => {
    render(<TerminalLinkConfirm />);
    confirmUrl("https://real-target.example/path");
    fireEvent.click(screen.getByTestId("terminal-link-confirm-confirm"));
    await waitFor(() =>
      expect(mocks.open).toHaveBeenCalledExactlyOnceWith("https://real-target.example/path"),
    );
    await waitFor(() => expect(useTerminalLinksStore.getState().confirming).toBeNull());
  });

  it("opens nothing on no", () => {
    render(<TerminalLinkConfirm />);
    confirmUrl("https://real-target.example/path");
    fireEvent.click(screen.getByTestId("terminal-link-confirm-cancel"));
    expect(useTerminalLinksStore.getState().confirming).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
  });
});

describe("the link hint over a pane", () => {
  const overlays = (isVisible = true, sessionId = "s1") => (
    <TerminalPaneOverlays sessionId={sessionId} isVisible={isVisible} statusShown={false} />
  );

  it("shows the target and how to open it, on the pane under the mouse only", () => {
    useTerminalLinksStore.setState({ hover: { sessionId: "s1", url: "https://example.com/" } });
    render(
      <>
        {overlays()}
        {overlays(true, "s2")}
      </>,
    );
    const hints = screen.getAllByTestId("terminal-link-hint");
    expect(hints).toHaveLength(1);
    expect(hints[0]).toHaveTextContent("https://example.com/");
    expect(hints[0]).toHaveTextContent("Ctrl+click to open");
  });

  it("does not linger once its pane is hidden", () => {
    useTerminalLinksStore.setState({ hover: { sessionId: "s1", url: "https://example.com/" } });
    const view = render(overlays());
    view.rerender(overlays(false));
    expect(screen.queryByTestId("terminal-link-hint")).toBeNull();
    expect(useTerminalLinksStore.getState().hover).toBeNull();
  });
});
