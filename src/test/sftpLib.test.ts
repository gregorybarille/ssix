import { describe, it, expect, vi, afterEach } from "vitest";
import {
  baseName,
  createTransferChannel,
  formatModeOctal,
  formatModeSymbolic,
  formatModified,
  formatSize,
  isSessionLost,
  opensAsFolder,
  parseMode,
  readableSftpError,
} from "@/lib/sftp";
import { TAURI_UNAVAILABLE_MESSAGE } from "@/lib/runtime";
import type { FileEntry, TransferEvent } from "@/types";

const entry = (patch: Partial<FileEntry>): FileEntry => ({
  name: "x",
  path: "/x",
  kind: "file",
  target_is_dir: false,
  size: 1,
  modified: null,
  mode: null,
  ...patch,
});

describe("sftp errors", () => {
  it("recognises a lost session and drops the marker from what is shown", () => {
    const error = "SFTP_SESSION_LOST The connection to the server was lost: timed out";
    expect(isSessionLost(error)).toBe(true);
    expect(readableSftpError(error)).toBe("The connection to the server was lost: timed out");
  });

  it("leaves other errors as they are", () => {
    expect(isSessionLost("Permission denied")).toBe(false);
    expect(readableSftpError("Permission denied")).toBe("Permission denied");
  });

  it("shows a host key mismatch as its explanation", () => {
    const error =
      "HOST_KEY_MISMATCH host=h port=22 fingerprint=SHA256:abc\nThe host key for h:22 has changed.";
    expect(readableSftpError(error)).toBe("The host key for h:22 has changed.");
  });
});

describe("formatSize", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [1024 ** 2, "1.0 MB"],
    [1024 ** 3, "1.0 GB"],
    [1024 ** 4, "1.0 TB"],
    [1024 ** 5, "1024.0 TB"],
  ])("%d is %s", (bytes, text) => {
    expect(formatSize(bytes)).toBe(text);
  });
});

describe("formatModified", () => {
  it("is empty when the time is unknown", () => {
    expect(formatModified(null)).toBe("");
  });

  it("reads seconds, not milliseconds", () => {
    expect(formatModified(86_400)).toBe(new Date(86_400_000).toLocaleString());
  });
});

describe("parseMode", () => {
  it.each([
    ["644", 0o644],
    ["0755", 0o755],
    [" 600 ", 0o600],
    ["4755", 0o4755],
  ])("accepts %s", (text, mode) => {
    expect(parseMode(text)).toBe(mode);
  });

  it.each(["", "64", "888", "77777", "rwx", "0x1ff", "-644", "6 4 4"])("refuses %j", (text) => {
    expect(parseMode(text)).toBeNull();
  });
});

describe("mode display", () => {
  it("writes octal with at least three digits", () => {
    expect(formatModeOctal(0o644)).toBe("644");
    expect(formatModeOctal(0o7)).toBe("007");
    expect(formatModeOctal(0o4755)).toBe("4755");
    expect(formatModeOctal(null)).toBe("");
  });

  it.each([
    [0o644, "rw-r--r--"],
    [0o755, "rwxr-xr-x"],
    [0o000, "---------"],
    [0o4755, "rwsr-xr-x"],
    [0o4644, "rwSr--r--"],
    [0o2755, "rwxr-sr-x"],
    [0o1777, "rwxrwxrwt"],
    [0o1776, "rwxrwxrwT"],
  ])("shows %o as %s", (mode, text) => {
    expect(formatModeSymbolic(mode)).toBe(text);
  });

  it("shows nothing for an unknown mode", () => {
    expect(formatModeSymbolic(null)).toBe("");
  });
});

describe("opensAsFolder", () => {
  it("opens folders and links to folders, nothing else", () => {
    expect(opensAsFolder(entry({ kind: "dir" }))).toBe(true);
    expect(opensAsFolder(entry({ kind: "symlink", target_is_dir: true }))).toBe(true);
    expect(opensAsFolder(entry({ kind: "symlink" }))).toBe(false);
    expect(opensAsFolder(entry({ kind: "file" }))).toBe(false);
    expect(opensAsFolder(entry({ kind: "other" }))).toBe(false);
  });
});

describe("baseName", () => {
  it.each([
    ["/home/me/a.txt", "a.txt"],
    ["/home/me/dir/", "dir"],
    ["C:\\Users\\me\\a.txt", "a.txt"],
    ["a.txt", "a.txt"],
    ["/", "/"],
  ])("%s is %s", (path, name) => {
    expect(baseName(path)).toBe(name);
  });
});

describe("createTransferChannel", () => {
  const bridge = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  afterEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = bridge;
  });

  it("delivers what the channel receives", async () => {
    const onEvent = vi.fn();
    const channel = (await createTransferChannel(onEvent)) as {
      onmessage: (event: TransferEvent) => void;
    };
    channel.onmessage({ type: "cancelled", id: "t" });
    expect(onEvent).toHaveBeenCalledWith({ type: "cancelled", id: "t" });
  });

  it("refuses outside the desktop app with the readable message", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    await expect(createTransferChannel(vi.fn())).rejects.toThrow(TAURI_UNAVAILABLE_MESSAGE);
  });
});
