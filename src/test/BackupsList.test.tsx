import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { BackupsList } from "@/components/BackupsList";
import { invoke } from "@/lib/tauri";
import { useBackupsStore } from "@/store/useBackupsStore";
import type { BackupInfo } from "@/types";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

const backup = (name: string, overrides: Partial<BackupInfo> = {}): BackupInfo => ({
  name,
  created_at: Date.UTC(2026, 9, 30, 15, 45),
  size: 2048,
  reason: "manual",
  files: ["data.json", "secrets.json"],
  error: null,
  ...overrides,
});

function respond(handlers: Record<string, (args?: Record<string, unknown>) => unknown>) {
  mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    const handler = handlers[cmd];
    if (!handler) return [];
    return handler(args);
  });
}

describe("BackupsList", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    useBackupsStore.setState({ dir: "", backups: [], error: null, isLoading: false });
  });

  it("lists the backups with their kind and size", async () => {
    respond({
      list_backups: () => ({
        dir: "/home/me/.ssix/backups",
        backups: [backup("ssix-backup-b.zip", { reason: "automatic" }), backup("ssix-backup-a.zip")],
      }),
    });
    render(<BackupsList />);
    const rows = await screen.findAllByTestId("backup-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText(/Automatic · 2.0 KB/)).toBeInTheDocument();
    expect(screen.getByText("/home/me/.ssix/backups")).toBeInTheDocument();
  });

  it("backs up now and announces the new archive", async () => {
    let backups: BackupInfo[] = [];
    respond({
      list_backups: () => ({ dir: "/d", backups }),
      create_backup: () => {
        backups = [backup("ssix-backup-new.zip")];
        return backups[0];
      },
    });
    render(<BackupsList />);
    fireEvent.click(screen.getByTestId("backup-create"));
    expect(await screen.findByTestId("backup-notice")).toHaveTextContent("ssix-backup-new.zip");
    expect(await screen.findAllByTestId("backup-row")).toHaveLength(1);
  });

  it("restores only after confirming, then reloads the app data", async () => {
    respond({
      list_backups: () => ({ dir: "/d", backups: [backup("ssix-backup-a.zip")] }),
      restore_backup: () => backup("ssix-backup-before.zip", { reason: "before_restore" }),
      get_settings: () => ({}),
    });
    render(<BackupsList />);
    fireEvent.click(await screen.findByTestId("backup-restore"));
    expect(mockInvoke).not.toHaveBeenCalledWith("restore_backup", expect.anything());
    fireEvent.click(screen.getByTestId("backup-restore-dialog-confirm"));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("restore_backup", { name: "ssix-backup-a.zip" }),
    );
    for (const cmd of ["get_connections", "get_credentials", "get_settings"]) {
      await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith(cmd));
    }
    expect(await screen.findByTestId("backup-notice")).toHaveTextContent("ssix-backup-before.zip");
  });

  it("keeps the confirm open with the reason when the restore is refused", async () => {
    respond({
      list_backups: () => ({ dir: "/d", backups: [backup("ssix-backup-a.zip")] }),
      restore_backup: () => {
        throw new Error("data.json does not match its checksum");
      },
    });
    render(<BackupsList />);
    fireEvent.click(await screen.findByTestId("backup-restore"));
    fireEvent.click(screen.getByTestId("backup-restore-dialog-confirm"));
    expect(await screen.findByTestId("backup-restore-dialog-error")).toHaveTextContent(
      "does not match its checksum",
    );
  });

  it("shows why a damaged archive cannot be restored", async () => {
    respond({
      list_backups: () => ({
        dir: "/d",
        backups: [backup("ssix-backup-x.zip", { reason: null, error: "Not a readable ZIP archive" })],
      }),
    });
    render(<BackupsList />);
    expect(await screen.findByText("Not a readable ZIP archive")).toBeInTheDocument();
    expect(screen.queryByTestId("backup-restore")).toBeNull();
    expect(screen.getByTestId("backup-delete")).toBeInTheDocument();
  });
});
