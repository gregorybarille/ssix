import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  connectMany,
  isBulkActionable,
  planBulkUpload,
  planBulkDownload,
  runBulkScp,
} from "@/lib/bulk-actions";
import type { Connection, ScpResult } from "@/types";
import { invoke } from "@/lib/tauri";
import { useTerminalsStore } from "@/store/useTerminalsStore";

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
  it("rejects local forwards", () => {
    expect(isBulkActionable(portfwd("1", "tun"))).toBe(false);
    expect(isBulkActionable(direct("2", "a"))).toBe(true);
  });

  it("rejects remote and dynamic forwards, which open no shell either", () => {
    const remote: Connection = {
      id: "3",
      name: "r",
      host: "g",
      port: 22,
      type: "remote_forward",
      gateway_host: "g",
      gateway_port: 22,
      gateway_credential_id: "c",
      remote_port: 8080,
      destination_host: "127.0.0.1",
      destination_port: 3000,
    };
    const dynamic: Connection = {
      id: "4",
      name: "d",
      host: "g",
      port: 22,
      type: "dynamic_forward",
      gateway_host: "g",
      gateway_port: 22,
      gateway_credential_id: "c",
      local_port: 1080,
    };
    expect(isBulkActionable(remote)).toBe(false);
    expect(isBulkActionable(dynamic)).toBe(false);
    expect(planBulkUpload([remote], { localPath: "/a", recursive: false })[0].status).toBe("skipped");
  });
});

describe("planBulkUpload", () => {
  it("marks local forward rows as skipped with explanatory error", () => {
    const plan = planBulkUpload(
      [direct("1", "a"), portfwd("2", "tun")],
      { localPath: "/tmp/x", remotePath: "/srv/x", recursive: false },
    );
    expect(plan[0].status).toBe("pending");
    expect(plan[1].status).toBe("skipped");
    expect(plan[1].error).toMatch(/port forward/i);
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

  it("starts no host once a stop was asked for, and marks a stopped host cancelled", async () => {
    let stopAsked = false;
    vi.mocked(invoke)
      .mockResolvedValueOnce({ local_path: "/x", remote_path: "/srv/x", bytes: 9 })
      .mockImplementationOnce(async () => {
        stopAsked = true;
        return { local_path: "/x", remote_path: "/x", bytes: 5, stopped: "Transfer stopped." };
      });
    const steps = planBulkUpload(
      [direct("1", "a"), direct("2", "b"), direct("3", "c"), portfwd("4", "tun")],
      { localPath: "/x", remotePath: "/srv/x", recursive: false },
    );
    const emitted: string[][] = [];
    const final = await runBulkScp(
      steps,
      "upload",
      false,
      (s) => emitted.push(s.map((r) => r.status)),
      () => stopAsked,
    );

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
    expect(final.map((s) => s.status)).toEqual(["success", "cancelled", "skipped", "skipped"]);
    expect(final[1].note).toBe("Transfer stopped.");
    expect(final[1].error).toBeUndefined();
    // The planned path stays: a stopped copy has no resolved one to report.
    expect(final[1].remotePath).toBe("/srv/x");
    expect(final[2].note).toMatch(/not started/i);
    // The forward keeps its own reason.
    expect(final[3].note).toBeUndefined();
    expect(emitted.at(-1)).toEqual(final.map((s) => s.status));
  });

  it("skips local forward steps without invoking the backend", async () => {
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

describe("connectMany", () => {
  it("opens every host without waiting for the first to log in", async () => {
    const connect = vi.fn((conn: Connection) =>
      conn.id === "1" ? new Promise<void>(() => {}) : Promise.resolve(),
    );
    useTerminalsStore.setState({ connect });

    const result = await connectMany([direct("1", "a"), direct("2", "b"), portfwd("3", "tun")]);

    expect(result).toEqual({ started: 2, skipped: 1 });
    expect(connect.mock.calls.map(([conn]) => conn.id)).toEqual(["1", "2"]);
  });
});
