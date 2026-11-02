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

describe("useConnectionsStore folders", () => {
  const conn = (id: string, folder?: string): Connection =>
    ({ id, name: id, host: "h", port: 22, type: "direct", folder }) as Connection;

  beforeEach(() => {
    vi.clearAllMocks();
    useConnectionsStore.setState({
      connections: [conn("a", "prod"), conn("b", "prod/eu"), conn("c")],
      error: null,
    });
  });

  it("moves one connection and keeps the order of the list", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(conn("b", "staging"));
    await useConnectionsStore.getState().moveConnectionToFolder("b", "staging");
    expect(invoke).toHaveBeenCalledWith("move_connection_to_folder", { id: "b", folder: "staging" });
    expect(useConnectionsStore.getState().connections).toEqual([
      conn("a", "prod"),
      conn("b", "staging"),
      conn("c"),
    ]);
  });

  it("sends null to take a connection out of any folder", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(conn("a"));
    await useConnectionsStore.getState().moveConnectionToFolder("a", null);
    expect(invoke).toHaveBeenCalledWith("move_connection_to_folder", { id: "a", folder: null });
  });

  it("makes one call to rename a folder and takes the whole answer", async () => {
    const answer = [conn("a", "live"), conn("b", "live/eu"), conn("c")];
    vi.mocked(invoke).mockResolvedValueOnce(answer);
    await useConnectionsStore.getState().renameFolder("prod", "live");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("rename_folder", { from: "prod", to: "live" });
    expect(useConnectionsStore.getState().connections).toEqual(answer);
  });

  it("makes one call to delete a folder and takes the whole answer", async () => {
    const answer = [conn("a"), conn("b"), conn("c")];
    vi.mocked(invoke).mockResolvedValueOnce(answer);
    await useConnectionsStore.getState().deleteFolder("prod");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("delete_folder", { path: "prod" });
    expect(useConnectionsStore.getState().connections).toEqual(answer);
  });

  it.each([
    ["moving", () => useConnectionsStore.getState().moveConnectionToFolder("a", "x")],
    ["renaming", () => useConnectionsStore.getState().renameFolder("prod", "x")],
    ["deleting", () => useConnectionsStore.getState().deleteFolder("prod")],
  ])("leaves the list and the load error alone when %s fails", async (_, action) => {
    const before = useConnectionsStore.getState().connections;
    vi.mocked(invoke).mockRejectedValueOnce("refused");
    await expect(action()).rejects.toBe("refused");
    expect(useConnectionsStore.getState().connections).toBe(before);
    expect(useConnectionsStore.getState().error).toBeNull();
  });
});
