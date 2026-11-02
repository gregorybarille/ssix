import { describe, it, expect, vi, beforeEach } from "vitest";
import { useConnectionsStore } from "@/store/useConnectionsStore";
import { usePortForwardsStore } from "@/store/usePortForwardsStore";
import { invoke } from "@/lib/tauri";
import type { Connection, ConnectionInput, ForwardConnection } from "@/types";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

describe("useConnectionsStore.deleteConnection", () => {
  const forward = (id: string): ForwardConnection => ({
    id,
    name: id,
    host: "",
    port: 22,
    type: "dynamic_forward",
    gateway_host: "bastion",
    gateway_port: 22,
    gateway_credential_id: "cred",
    local_port: 1080,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue(undefined);
    useConnectionsStore.setState({ connections: [forward("gone"), forward("kept")] });
    usePortForwardsStore.setState({
      sessions: [
        { sessionId: "s-gone", connectionName: "gone", connection: forward("gone") },
        { sessionId: "s-kept", connectionName: "kept", connection: forward("kept") },
      ],
    });
  });

  it("stops the connection's forward before deleting it, and only that one", async () => {
    await useConnectionsStore.getState().deleteConnection("gone");

    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["ssh_disconnect", { sessionId: "s-gone" }],
      ["delete_connection", { id: "gone" }],
    ]);
    expect(usePortForwardsStore.getState().sessions.map((s) => s.sessionId)).toEqual(["s-kept"]);
    expect(useConnectionsStore.getState().connections.map((c) => c.id)).toEqual(["kept"]);
  });

  it("does not disconnect anything for a connection with no forward running", async () => {
    await useConnectionsStore.getState().deleteConnection("kept-not-running");

    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["delete_connection", { id: "kept-not-running" }],
    ]);
  });
});

describe("useConnectionsStore.cloneConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConnectionsStore.setState({ connections: [], isLoading: false, error: null });
  });

  it("sends the whole clone form with the original's id and adds the result", async () => {
    const form: ConnectionInput = {
      type: "jump_shell",
      name: "db copy",
      host: "db",
      port: 22,
      credential_id: "dest",
      gateway_host: "gw2",
      gateway_port: 2222,
      gateway_credential_id: "gw-cred-2",
      destination_host: "db",
      destination_port: 22,
      tags: ["prod"],
      verbosity: 1,
    };
    const saved = { ...form, id: "new" } as Connection;
    vi.mocked(invoke).mockResolvedValueOnce(saved);

    await useConnectionsStore.getState().cloneConnection("orig", form);

    expect(invoke).toHaveBeenCalledWith("clone_connection", { input: { ...form, id: "orig" } });
    expect(useConnectionsStore.getState().connections).toEqual([saved]);
  });
});
