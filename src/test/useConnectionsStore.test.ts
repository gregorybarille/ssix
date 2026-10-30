import { describe, it, expect, vi, beforeEach } from "vitest";
import { useConnectionsStore } from "@/store/useConnectionsStore";
import { invoke } from "@/lib/tauri";
import type { Connection, ConnectionInput } from "@/types";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

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
