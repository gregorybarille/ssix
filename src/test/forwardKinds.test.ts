import { beforeEach, describe, expect, it, vi } from "vitest";
import { mirroredEndpoint } from "@/components/connection-form/endpoint";
import { forwardEndpoint, hopTerms } from "@/lib/sshTerms";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import { usePortForwardsStore } from "@/store/usePortForwardsStore";
import type { Connection, ForwardConnection } from "@/types";

const base = {
  id: "c1",
  name: "fwd",
  host: "h",
  port: 22,
  verbosity: 0,
  agent_forwarding: false,
  gateway_host: "bastion",
  gateway_port: 2222,
  gateway_credential_id: "cred",
};

const local = {
  ...base,
  type: "port_forward",
  local_port: 15432,
  destination_host: "db",
  destination_port: 5432,
} as ForwardConnection;
const remote = {
  ...base,
  type: "remote_forward",
  remote_port: 9000,
  destination_host: "127.0.0.1",
  destination_port: 3000,
} as ForwardConnection;
const dynamic = { ...base, type: "dynamic_forward", local_port: 1080 } as ForwardConnection;

describe("forwardEndpoint", () => {
  it("describes each forward kind", () => {
    expect(forwardEndpoint(local)).toBe("127.0.0.1:15432 → db:5432");
    expect(forwardEndpoint(remote)).toBe("remote port 9000 → 127.0.0.1:3000");
    expect(forwardEndpoint(dynamic)).toBe("127.0.0.1:1080 (SOCKS)");
  });

  it("names the address a forward was told to listen on", () => {
    expect(forwardEndpoint({ ...local, bind_address: "10.0.0.5" } as ForwardConnection)).toBe(
      "10.0.0.5:15432 → db:5432",
    );
    expect(forwardEndpoint({ ...dynamic, bind_address: "::1" } as ForwardConnection)).toBe(
      "[::1]:1080 (SOCKS)",
    );
  });
});

describe("hopTerms", () => {
  it("does not call the local end of a remote forward remote", () => {
    expect(hopTerms("remote_forward").targetHost).toBe("Local target host");
    expect(hopTerms("remote_forward").targetPort).toBe("Local target port");
    expect(hopTerms("port_forward").targetHost).toBe("Remote host");
  });
});

describe("mirroredEndpoint", () => {
  const form = { host: "direct-host", port: 2200, gateway_host: "bastion", gateway_port: 2222 };

  it("keeps the host and port of a direct connection", () => {
    expect(mirroredEndpoint("direct", form)).toEqual({ host: "direct-host", port: 2200 });
  });

  it("mirrors the far end of a kind that has one", () => {
    const draft = { ...form, destination_host: "db", destination_port: 5432 };
    expect(mirroredEndpoint("port_forward", draft)).toEqual({ host: "db", port: 5432 });
    expect(mirroredEndpoint("remote_forward", draft)).toEqual({ host: "db", port: 5432 });
    expect(mirroredEndpoint("jump_shell", draft)).toEqual({ host: "db", port: 5432 });
  });

  it("uses the SSH server for a dynamic forward, ignoring a destination another tab left", () => {
    for (const destination_host of ["stale", ""]) {
      const draft = { ...form, destination_host, destination_port: 5432 };
      expect(mirroredEndpoint("dynamic_forward", draft)).toEqual({
        host: "bastion",
        port: 2222,
      });
    }
  });
});

describe("connect", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([local, remote, dynamic])("sends a $type to the forwards store, not a tab", async (conn) => {
    const startForward = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(usePortForwardsStore, "getState").mockReturnValue({
      ...usePortForwardsStore.getState(),
      startForward,
    });
    await useTerminalsStore.getState().connect(conn as Connection);
    expect(startForward).toHaveBeenCalledWith(conn);
    expect(useTerminalsStore.getState().tabs).toEqual([]);
  });
});
