import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { FilePane } from "@/components/sftp/FilePane";
import { formatModeSymbolic } from "@/lib/sftp";
import { useSftpStore } from "@/store/useSftpStore";
import type { FileEntry } from "@/types";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));
// Every row formats its mode once per render, so this counts row renders.
vi.mock("@/lib/sftp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sftp")>();
  return { ...actual, formatModeSymbolic: vi.fn(actual.formatModeSymbolic) };
});
const rowRenders = vi.mocked(formatModeSymbolic);

const entries: FileEntry[] = ["a.txt", "b.txt", "c.txt"].map((name) => ({
  name,
  path: `/work/${name}`,
  kind: "file",
  target_is_dir: false,
  size: 1,
  modified: 1,
  mode: 0o644,
}));

const initialState = useSftpStore.getState();

beforeEach(() => {
  useSftpStore.setState(initialState, true);
  useSftpStore.setState((s) => ({ local: { ...s.local, path: "/work", entries } }));
  rowRenders.mockClear();
});

describe("FilePane renders", () => {
  it("leaves the rows alone while a path is typed", () => {
    render(<FilePane side="local" title="This computer" />);
    const rendered = rowRenders.mock.calls.length;
    expect(rendered).toBeGreaterThanOrEqual(entries.length);

    const field = screen.getByTestId("files-path-local");
    for (const typed of ["/work/", "/work/s", "/work/su", "/work/sub"]) {
      fireEvent.change(field, { target: { value: typed } });
      expect(field).toHaveValue(typed);
    }
    expect(rowRenders.mock.calls.length).toBe(rendered);
  });

  it("shows the folder the pane moves to, over what was typed", () => {
    render(<FilePane side="local" title="This computer" />);
    const field = screen.getByTestId("files-path-local");
    fireEvent.change(field, { target: { value: "/somewhere" } });
    act(() => useSftpStore.setState((s) => ({ local: { ...s.local, path: "/elsewhere" } })));
    expect(field).toHaveValue("/elsewhere");
  });
});
