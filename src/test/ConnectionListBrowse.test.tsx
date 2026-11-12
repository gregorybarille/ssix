import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConnectionList } from "@/components/ConnectionList";
import type { Connection } from "@/types";

const direct: Connection = {
  id: "c1",
  name: "web",
  host: "web",
  port: 22,
  type: "direct",
};
const jump: Connection = {
  id: "j1",
  name: "inner",
  host: "",
  port: 22,
  type: "jump_shell",
  gateway_host: "gw",
  gateway_port: 22,
  gateway_credential_id: "k",
  destination_host: "inner",
  destination_port: 22,
};
const forward: Connection = {
  id: "f1",
  name: "tunnel",
  host: "",
  port: 22,
  type: "port_forward",
  gateway_host: "gw",
  gateway_port: 22,
  gateway_credential_id: "k",
  local_port: 8080,
  destination_host: "x",
  destination_port: 80,
};

function renderList(onBrowse?: (connection: Connection) => void) {
  const onConnect = vi.fn();
  render(
    <ConnectionList
      connections={[direct, jump, forward]}
      credentials={[]}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onClone={vi.fn()}
      onConnect={onConnect}
      onBrowse={onBrowse}
    />,
  );
  return { onConnect };
}

describe("ConnectionList Browse files action", () => {
  it("opens a direct or jump host connection, without activating the row", () => {
    const onBrowse = vi.fn();
    const { onConnect } = renderList(onBrowse);
    fireEvent.click(screen.getByRole("button", { name: "Browse files on web" }));
    expect(onBrowse).toHaveBeenCalledWith(direct);
    fireEvent.click(screen.getByTestId("browse-files-j1"));
    expect(onBrowse).toHaveBeenCalledWith(jump);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("is not offered on a forward", () => {
    renderList(vi.fn());
    expect(screen.queryByTestId("browse-files-f1")).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByTestId("connection-row-f1"));
    const menu = screen.getByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Browse files" })).not.toBeInTheDocument();
  });

  it("is in the row's context menu", async () => {
    const onBrowse = vi.fn();
    renderList(onBrowse);
    fireEvent.contextMenu(screen.getByTestId("connection-row-c1"));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Browse files" }));
    await waitFor(() => expect(onBrowse).toHaveBeenCalledWith(direct));
  });

  it("is left out when the list has no handler", () => {
    renderList();
    expect(screen.queryByTestId("browse-files-c1")).not.toBeInTheDocument();
  });
});
