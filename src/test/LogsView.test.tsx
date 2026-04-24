import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LogsView } from "@/components/LogsView";
import { useFrontendLogs } from "@/lib/log";
import { LogEntry } from "@/types";

const mockBackendEntries: LogEntry[] = [
  { ts: 1000000000000, level: "info", source: "ssh", message: "Connected to host" },
  { ts: 1000000001000, level: "error", source: "storage", message: "Failed to save data" },
];

const mockFrontendEntry: LogEntry = {
  ts: 1000000002000,
  level: "warn",
  source: "app",
  message: "App started",
};

type AppLogCallback = (event: { payload: LogEntry }) => void;

describe("LogsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure get_logs always resolves with an array by default so
    // setBackend(list) never receives undefined and breaks the render.
    vi.mocked(invoke).mockResolvedValue([]);
    useFrontendLogs.setState({ entries: [] });
  });

  it("renders the Backend tab by default and shows fetched entries", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(mockBackendEntries);
    render(<LogsView />);
    await waitFor(() => {
      expect(screen.getByText("Connected to host")).toBeInTheDocument();
      expect(screen.getByText("Failed to save data")).toBeInTheDocument();
    });
  });

  it("shows empty state message when there are no backend entries", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    render(<LogsView />);
    await waitFor(() => {
      expect(screen.getByText("No backend log entries.")).toBeInTheDocument();
    });
  });

  it("renders frontend entries when the Frontend tab is selected", async () => {
    const user = userEvent.setup();
    useFrontendLogs.setState({ entries: [mockFrontendEntry] });
    render(<LogsView />);
    await user.click(screen.getByRole("tab", { name: /Frontend/ }));
    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /Frontend/ }),
      ).toHaveAttribute("aria-selected", "true");
    });
    expect(screen.getByText("App started")).toBeInTheDocument();
  });

  it("shows empty state message when there are no frontend entries", async () => {
    const user = userEvent.setup();
    render(<LogsView />);
    await user.click(screen.getByRole("tab", { name: /Frontend/ }));
    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /Frontend/ }),
      ).toHaveAttribute("aria-selected", "true");
    });
    expect(screen.getByText("No frontend log entries.")).toBeInTheDocument();
  });

  it("calls clear_logs when Clear is clicked on the Backend tab", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(mockBackendEntries);
    render(<LogsView />);
    await waitFor(() =>
      expect(screen.getByText("Connected to host")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Clear/i }));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("clear_logs", undefined);
    });
  });

  it("clears frontend entries when Clear is clicked on the Frontend tab", async () => {
    const user = userEvent.setup();
    useFrontendLogs.setState({ entries: [mockFrontendEntry] });
    render(<LogsView />);
    await user.click(screen.getByRole("tab", { name: /Frontend/ }));
    // Wait until the tab is actually selected before clicking Clear.
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: /Frontend/ }),
      ).toHaveAttribute("aria-selected", "true"),
    );
    fireEvent.click(screen.getByRole("button", { name: /Clear/i }));
    expect(useFrontendLogs.getState().entries).toHaveLength(0);
  });

  it("displays the correct entry count in each tab label", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(mockBackendEntries);
    useFrontendLogs.setState({ entries: [mockFrontendEntry] });
    render(<LogsView />);
    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /Backend \(2\)/ }),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("tab", { name: /Frontend \(1\)/ })).toBeInTheDocument();
  });

  it("appends live backend log entries via app-log event", async () => {
    let capturedCallback: AppLogCallback | null = null;
    vi.mocked(listen).mockImplementationOnce(async (_event, callback) => {
      capturedCallback = callback as AppLogCallback;
      return () => {};
    });

    render(<LogsView />);

    await waitFor(() => {
      expect(capturedCallback).not.toBeNull();
    });

    act(() => {
      capturedCallback!({
        payload: { ts: 1000000003000, level: "info", source: "ssh", message: "Live entry" },
      });
    });

    expect(screen.getByText("Live entry")).toBeInTheDocument();
  });

  it("calls unlisten on unmount", async () => {
    const unlisten = vi.fn();
    vi.mocked(listen).mockResolvedValueOnce(unlisten);

    const { unmount } = render(<LogsView />);

    await waitFor(() => {
      expect(vi.mocked(listen)).toHaveBeenCalled();
    });

    unmount();
    expect(unlisten).toHaveBeenCalled();
  });

  /*
   * P2-A2: levels must be distinguishable without color (WCAG 1.4.1).
   * Each level renders as a bordered badge with a leading aria-hidden
   * glyph; color is supplementary, not the only signal.
   */
  it("renders each log level as a bordered badge with a non-color glyph", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      { ts: 1000000000000, level: "info", source: "ssh", message: "i-msg" },
      { ts: 1000000001000, level: "warn", source: "ssh", message: "w-msg" },
      { ts: 1000000002000, level: "error", source: "ssh", message: "e-msg" },
    ]);
    render(<LogsView />);
    await waitFor(() =>
      expect(screen.getByText("i-msg")).toBeInTheDocument(),
    );
    // The level label is rendered inside an inline-flex bordered span;
    // walk up from the visible text label to confirm the box class
    // and the presence of an aria-hidden glyph sibling.
    for (const [label, glyph] of [
      ["info", "\u2139"],
      ["warn", "\u25B2"],
      ["error", "\u2715"],
    ]) {
      const labelEl = screen.getByText(label);
      // The badge wraps both the glyph and the label.
      expect(labelEl.className).toMatch(/border/);
      const glyphEl = labelEl.querySelector('[aria-hidden="true"]');
      expect(glyphEl).not.toBeNull();
      expect(glyphEl?.textContent).toBe(glyph);
    }
  });
});
