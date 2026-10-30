/**
 * A failed load must never look like an empty list: the Connections and
 * Credentials views show the store's load error with a Retry button.
 * Form actions report their failures to the form and must not leave a
 * stale list-level error behind.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionsView } from "@/components/views/ConnectionsView";
import { CredentialsView } from "@/components/views/CredentialsView";
import { useConnectionsStore } from "@/store/useConnectionsStore";
import { useCredentialsStore } from "@/store/useCredentialsStore";
import { useSettingsStore } from "@/store/useSettingsStore";
import { invoke } from "@/lib/tauri";
import type { AppSettings } from "@/types";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

const settings: AppSettings = {
  font_size: 14,
  font_family: "monospace",
  color_scheme: "blue",
  theme: "dark",
  connection_layout: "list",
  credential_layout: "list",
  tunnel_layout: "list",
  default_open_mode: "tab",
  auto_copy_selection: false,
  git_sync_remote: "origin",
  backup_enabled: true,
  backup_interval_hours: 24,
  backup_keep: 10,
};

const LOAD_ERROR = "/home/u/.ssix/data.json is not valid SSIX data: expected value at line 1";

function renderConnectionsView() {
  return render(
    <ConnectionsView
      connections={useConnectionsStore.getState().connections}
      credentials={[]}
      settings={settings}
      onLayoutChange={vi.fn()}
      onSubmit={vi.fn()}
      onCloneSubmit={vi.fn()}
      onDiscardCredential={vi.fn()}
      onCreateCredential={vi.fn()}
      onDelete={vi.fn()}
      onConnect={vi.fn()}
      onConnectAllInTag={vi.fn()}
      onScpAllInTag={vi.fn()}
    />,
  );
}

describe("load-error banners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConnectionsStore.setState({ connections: [], error: null, isLoading: false });
    useCredentialsStore.setState({ credentials: [], error: null, isLoading: false });
  });

  it("Connections view shows no banner when the load succeeded", () => {
    renderConnectionsView();
    expect(screen.queryByTestId("connections-load-error")).toBeNull();
  });

  it("Connections view shows the load error and retries the fetch", async () => {
    const user = userEvent.setup();
    useConnectionsStore.setState({ error: LOAD_ERROR });
    renderConnectionsView();

    const banner = screen.getByTestId("connections-load-error");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent(/could not load connections/i);
    expect(banner).toHaveTextContent(/data\.json is not valid SSIX data/);

    vi.mocked(invoke).mockResolvedValueOnce([]);
    await user.click(screen.getByTestId("connections-load-error-retry"));
    expect(invoke).toHaveBeenCalledWith("get_connections");
    await waitFor(() => expect(screen.queryByTestId("connections-load-error")).toBeNull());
  });

  it("Credentials view shows the load error and retries the fetch", async () => {
    const user = userEvent.setup();
    useCredentialsStore.setState({ error: LOAD_ERROR });
    render(
      <CredentialsView
        credentials={[]}
        settings={settings}
        onLayoutChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByTestId("credentials-load-error")).toHaveTextContent(
      /could not load credentials/i,
    );

    vi.mocked(invoke).mockResolvedValueOnce([]);
    await user.click(screen.getByTestId("credentials-load-error-retry"));
    expect(invoke).toHaveBeenCalledWith("get_credentials");
    await waitFor(() => expect(screen.queryByTestId("credentials-load-error")).toBeNull());
  });

  it("a failed save is reported to its caller and does not become a load error", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("A connection named 'prod' already exists");
    await expect(
      useConnectionsStore.getState().addConnection({
        name: "prod",
        host: "h",
        port: 22,
        type: "direct",
      } as never),
    ).rejects.toBe("A connection named 'prod' already exists");
    expect(useConnectionsStore.getState().error).toBeNull();

    vi.mocked(invoke).mockRejectedValueOnce("Credential not found");
    await expect(
      useCredentialsStore.getState().deleteCredential("nope"),
    ).rejects.toBe("Credential not found");
    expect(useCredentialsStore.getState().error).toBeNull();

    vi.mocked(invoke).mockRejectedValueOnce("Git remote must not start with '-'.");
    await expect(
      useSettingsStore.getState().saveSettings({ ...settings, git_sync_remote: "-f" }),
    ).rejects.toBe("Git remote must not start with '-'.");
    expect(useSettingsStore.getState().error).toBeNull();
  });

  it("a failed load is recorded for the banner", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(LOAD_ERROR);
    await useConnectionsStore.getState().fetchConnections();
    expect(useConnectionsStore.getState().error).toBe(LOAD_ERROR);
  });
});
