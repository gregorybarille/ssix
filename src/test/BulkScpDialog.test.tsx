import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BulkScpDialog } from "@/components/BulkScpDialog";
import { invoke } from "@/lib/tauri";
import type { Connection, ScpResult } from "@/types";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));

const host = (id: string): Connection =>
  ({ id, name: `host-${id}`, host: id, port: 22, type: "direct" }) as Connection;

const row = (id: string) => screen.getByTestId(`bulk-scp-row-${id}`);

const copied: ScpResult = { local_path: "/l", remote_path: "/r/l", bytes: 5, entries: 1 };

describe("BulkScpDialog Stop", () => {
  let finishCopy: Record<string, (result: ScpResult) => void>;

  beforeEach(() => {
    finishCopy = {};
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(((command: string, args: unknown) => {
      if (command === "scp_stop") return Promise.resolve();
      const id = (args as { input: { connection_id: string } }).input.connection_id;
      return new Promise((resolve) => {
        finishCopy[id] = resolve as (result: ScpResult) => void;
      });
    }) as typeof invoke);
  });

  async function start(hosts: Connection[], onOpenChange = vi.fn()) {
    render(
      <BulkScpDialog open onOpenChange={onOpenChange} connections={hosts} groupLabel="prod" />,
    );
    fireEvent.change(screen.getByTestId("bulk-scp-local-path"), { target: { value: "/l" } });
    fireEvent.change(screen.getByTestId("bulk-scp-remote-path"), { target: { value: "/r" } });
    expect(screen.queryByTestId("bulk-scp-stop")).toBeNull();
    fireEvent.click(screen.getByTestId("bulk-scp-start"));
    await waitFor(() => expect(finishCopy[hosts[0].id]).toBeDefined());
  }

  it("stops the current host, skips the rest and keeps what is done", async () => {
    await start([host("a"), host("b"), host("c")]);

    await act(async () => finishCopy.a(copied));
    await waitFor(() => expect(finishCopy.b).toBeDefined());

    const stop = screen.getByTestId("bulk-scp-stop");
    expect(stop).toHaveTextContent("Stop");
    fireEvent.click(stop);
    expect(invoke).toHaveBeenCalledWith("scp_stop", { connectionId: "b" });
    expect(screen.getByTestId("bulk-scp-stop")).toBeDisabled();
    expect(screen.getByTestId("bulk-scp-stop")).toHaveTextContent("Stopping...");
    expect(screen.queryByTestId("bulk-scp-summary")).toBeNull();

    await act(async () =>
      finishCopy.b({ ...copied, entries: 0, stopped: "Transfer stopped after 5 bytes." }),
    );

    expect(row("a")).toHaveAttribute("data-status", "success");
    expect(row("b")).toHaveAttribute("data-status", "cancelled");
    expect(row("b")).toHaveTextContent("Transfer stopped after 5 bytes.");
    expect(row("b").querySelector(".text-destructive")).toBeNull();
    expect(row("c")).toHaveAttribute("data-status", "skipped");
    expect(row("c")).toHaveTextContent(/not started/i);
    expect(finishCopy.c).toBeUndefined();
    expect(screen.getByTestId("bulk-scp-summary")).toHaveTextContent(
      "Transfer stopped — 1 succeeded, 1 stopped, 1 skipped.",
    );
    expect(screen.queryByTestId("bulk-scp-stop")).toBeNull();
  });

  it("skips the rest when the copy finished just as the stop came", async () => {
    await start([host("a"), host("b")]);
    fireEvent.click(screen.getByTestId("bulk-scp-stop"));
    await act(async () => finishCopy.a(copied));

    expect(row("a")).toHaveAttribute("data-status", "success");
    expect(row("b")).toHaveAttribute("data-status", "skipped");
    expect(finishCopy.b).toBeUndefined();
    expect(screen.getByTestId("bulk-scp-summary")).toHaveTextContent(
      "Transfer stopped — 1 succeeded, 0 stopped, 1 skipped.",
    );
  });

  it("keeps the usual summary when nothing was stopped", async () => {
    await start([host("a")]);
    await act(async () => finishCopy.a(copied));
    expect(screen.getByTestId("bulk-scp-summary")).toHaveTextContent("1/1 done — 1 succeeded.");
  });

  it("does not close while running, however it is asked", async () => {
    const onOpenChange = vi.fn();
    await start([host("a")], onOpenChange);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText("Close", { selector: "button" })).toBeDisabled();
    await act(async () => finishCopy.a(copied));
  });
});
