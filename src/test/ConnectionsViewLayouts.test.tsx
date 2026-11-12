import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConnectionsView } from "@/components/views/ConnectionsView";
import { CredentialsView } from "@/components/views/CredentialsView";
import { useConnectionsStore } from "@/store/useConnectionsStore";
import type { AppSettings, Connection, ConnectionLayout } from "@/types";

/** These views read only the layouts. */
const settings = (connection_layout: ConnectionLayout) =>
  ({ connection_layout, credential_layout: "list", tunnel_layout: "list" }) as AppSettings;

const CONNECTIONS: Connection[] = [
  { id: "a", name: "filed", host: "h", port: 22, type: "direct", folder: "prod" },
  { id: "b", name: "loose", host: "h", port: 22, type: "direct" },
];

function renderView(layout: ConnectionLayout) {
  const onLayoutChange = vi.fn();
  render(
    <ConnectionsView
      connections={CONNECTIONS}
      credentials={[]}
      settings={settings(layout)}
      onLayoutChange={onLayoutChange}
      onSubmit={vi.fn()}
      onCloneSubmit={vi.fn()}
      onCreateCredential={vi.fn()}
      onDiscardCredential={vi.fn()}
      onDelete={vi.fn()}
      onConnect={vi.fn()}
      onConnectAllInTag={vi.fn()}
      onScpAllInTag={vi.fn()}
    />,
  );
  return { onLayoutChange };
}

beforeEach(() => {
  useConnectionsStore.setState({ connections: CONNECTIONS, error: null, isLoading: false });
});

describe("the Connections view's layouts", () => {
  it("shows the tree for the folders layout, with the same rows", () => {
    renderView("folders");
    expect(screen.getByTestId("folder-tree")).toBeInTheDocument();
    expect(screen.getByTestId("connection-row-a")).toHaveAttribute("data-name", "filed");
    expect(screen.getByTestId("connection-row-b")).toHaveAttribute("data-name", "loose");
    expect(screen.getByTestId("layout-toggle-folders")).toHaveAttribute("aria-pressed", "true");
  });

  it("offers the tree from the list", () => {
    const { onLayoutChange } = renderView("list");
    expect(screen.queryByTestId("folder-tree")).not.toBeInTheDocument();
    expect(screen.getByTestId("connection-row-a")).toBeInTheDocument();
    screen.getByTestId("layout-toggle-folders").click();
    expect(onLayoutChange).toHaveBeenCalledWith("folders");
  });

  it.each(["list", "tile"] as const)("keeps the row's buttons in the tab order for %s", (layout) => {
    renderView(layout);
    expect(screen.getByTestId("connect-button-a").tabIndex).toBe(0);
    expect(screen.getByTestId("edit-connection-a").tabIndex).toBe(0);
  });

  it.each(["list", "tile"] as const)("says a search found nothing for %s", async (layout) => {
    renderView(layout);
    fireEvent.change(screen.getByTestId("connection-search-input"), {
      target: { value: "nothing-matches" },
    });
    expect(await screen.findByText("No matching connections")).toBeInTheDocument();
    expect(screen.queryByText("No connections yet")).not.toBeInTheDocument();
  });

  it("still shows every row for a layout it does not know", () => {
    renderView("from-the-future" as ConnectionLayout);
    expect(screen.queryByTestId("folder-tree")).not.toBeInTheDocument();
    expect(screen.getByTestId("connection-row-a")).toBeInTheDocument();
    expect(screen.getByTestId("connection-row-b")).toBeInTheDocument();
  });
});

describe("the other lists", () => {
  it("do not offer the folders layout", () => {
    render(
      <CredentialsView
        credentials={[]}
        settings={settings("folders")}
        onLayoutChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole("group", { name: "Layout" })).toBeInTheDocument();
    expect(screen.queryByTestId("layout-toggle-folders")).not.toBeInTheDocument();
  });
});
