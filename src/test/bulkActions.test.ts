import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isBulkActionable,
  planBulkUpload,
  planBulkDownload,
  runBulkScp,
} from "@/lib/bulk-actions";
import type { Connection, ScpResult } from "@/types";
import { invoke } from "@/lib/tauri";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));

const direct = (id: string, name: string, remote_path?: string): Connection =>
  ({
    id,
    name,
    host: `${name}.h`,
    port: 22,
    type: "direct",
    remote_path,
  }) as Connection;

const portfwd = (id: string, name: string): Connection =>
  ({
    id,
    name,
    host: name,
    port: 22,
    type: "port_forward",
    gateway_host: "g",
    gateway_port: 22,
    gateway_credential_id: "c",
    local_port: 9000,
    destination_host: "d",
    destination_port: 80,
  }) as Connection;

describe("isBulkActionable", () => {
  it("rejects port-forward connections", () => {
    expect(isBulkActionable(portfwd("1", "tun"))).toBe(false);
    expect(isBulkActionable(direct("2", "a"))).toBe(true);
  });
});

describe("planBulkUpload", () => {
  it("marks port-forward rows as skipped with explanatory error", () => {
    const plan = planBulkUpload(
      [direct("1", "a"), portfwd("2", "tun")],
      { localPath: "/tmp/x", remotePath: "/srv/x", recursive: false },
    );
    expect(plan[0].status).toBe("pending");
    expect(plan[1].status).toBe("skipped");
    expect(plan[1].error).toMatch(/port-forward/i);
  });

  it("falls back to conn.remote_path when remotePath is unset", () => {
    const plan = planBulkUpload(
      [direct("1", "a", "/var/app")],
      { localPath: "/tmp/x", recursive: false },
    );
    expect(plan[0].remotePath).toBe("/var/app");
  });
});

describe("planBulkDownload", () => {
  it("computes per-host suffixed local paths", () => {
    const plan = planBulkDownload(
      [direct("1", "alpha"), direct("2", "beta")],
      { remotePath: "/var/log/app.log", localDir: "/tmp/dl", recursive: false },
    );
    expect(plan[0].localPath).toBe("/tmp/dl/app-alpha.log");
    expect(plan[1].localPath).toBe("/tmp/dl/app-beta.log");
  });
});

describe("runBulkScp", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("calls scp_upload for each non-skipped step in order and reports progress", async () => {
    const result: ScpResult = {
      local_path: "/tmp/x",
      remote_path: "/srv/x",
      bytes: 10,
    };
    vi.mocked(invoke).mockResolvedValue(result);

    const steps = planBulkUpload(
      [direct("1", "a"), direct("2", "b")],
      { localPath: "/tmp/x", remotePath: "/srv/x", recursive: false },
    );
    const snapshots: number[] = [];
    const final = await runBulkScp(steps, "upload", false, (s) =>
      snapshots.push(s.filter((r) => r.status === "running").length),
    );

    expect(final.every((s) => s.status === "success")).toBe(true);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(invoke).mock.calls[0][0]).toBe("scp_upload");
    // At some progress emit, exactly one row was running.
    expect(snapshots).toContain(1);
  });

  it("records per-row errors without aborting the batch", async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error("connect failed"))
      .mockResolvedValueOnce({
        local_path: "/tmp/x",
        remote_path: "/srv/x",
        bytes: 5,
      });

    const steps = planBulkUpload(
      [direct("1", "a"), direct("2", "b")],
      { localPath: "/tmp/x", remotePath: "/srv/x", recursive: false },
    );
    const final = await runBulkScp(steps, "upload", false, () => {});
    expect(final[0].status).toBe("error");
    expect(final[0].error).toMatch(/connect failed/);
    expect(final[1].status).toBe("success");
  });

  it("invokes scp_download for download mode", async () => {
    vi.mocked(invoke).mockResolvedValue({
      local_path: "/tmp/dl/app-a.log",
      remote_path: "/var/log/app.log",
      bytes: 99,
    });
    const steps = planBulkDownload(
      [direct("1", "a")],
      { remotePath: "/var/log/app.log", localDir: "/tmp/dl", recursive: false },
    );
    await runBulkScp(steps, "download", false, () => {});
    expect(vi.mocked(invoke).mock.calls[0][0]).toBe("scp_download");
  });

  it("skips port-forward steps without invoking the backend", async () => {
    vi.mocked(invoke).mockResolvedValue({
      local_path: "",
      remote_path: "",
      bytes: 0,
    });
    const steps = planBulkUpload(
      [portfwd("1", "tun")],
      { localPath: "/tmp/x", remotePath: "/srv/x", recursive: false },
    );
    await runBulkScp(steps, "upload", false, () => {});
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });
});
