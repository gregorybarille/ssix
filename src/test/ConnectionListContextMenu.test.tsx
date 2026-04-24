import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConnectionList } from "@/components/ConnectionList";
import type { Connection, Credential } from "@/types";

const cred: Credential = {
  id: "p1",
  name: "Prod",
  username: "alice",
  type: "password",
  password: "x",
};

const direct: Connection = {
  id: "c1",
  name: "web",
  host: "example.com",
  port: 22,
  type: "direct",
  credential_id: cred.id,
};

const tunnel: Connection = {
  id: "c2",
  name: "fwd",
  host: "",
  port: 22,
  type: "port_forward",
  gateway_host: "gw.example",
  gateway_port: 22,
  gateway_credential_id: cred.id,
  local_port: 5432,
  destination_host: "db.internal",
  destination_port: 5432,
};

describe("ConnectionList right-click context menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom doesn't ship a clipboard implementation by default.
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("opens a menu with Connect / Edit / Clone / Copy / Delete on right-click", () => {
    const onConnect = vi.fn();
    const onEdit = vi.fn();
    const onClone = vi.fn();
    const onDelete = vi.fn();
    render(
      <ConnectionList
        connections={[direct]}
        credentials={[cred]}
        onConnect={onConnect}
        onEdit={onEdit}
        onClone={onClone}
        onDelete={onDelete}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("listitem"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /connect/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /clone/i })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /copy ssh command/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /delete/i })).toBeInTheDocument();
  });

  it("hides Transfer files for port_forward connections", () => {
    render(
      <ConnectionList
        connections={[tunnel]}
        credentials={[cred]}
        onEdit={vi.fn()}
        onClone={vi.fn()}
        onDelete={vi.fn()}
        onConnect={vi.fn()}
        onScp={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("listitem"));
    expect(
      screen.queryByRole("menuitem", { name: /transfer files/i }),
    ).not.toBeInTheDocument();
  });

  it("invokes onClone when Clone is selected", async () => {
    const onClone = vi.fn();
    render(
      <ConnectionList
        connections={[direct]}
        credentials={[cred]}
        onEdit={vi.fn()}
        onClone={onClone}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("listitem"));
    fireEvent.click(screen.getByRole("menuitem", { name: /clone/i }));
    await waitFor(() => expect(onClone).toHaveBeenCalledWith(direct));
  });

  it("Copy SSH command writes the built command to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <ConnectionList
        connections={[direct]}
        credentials={[cred]}
        onEdit={vi.fn()}
        onClone={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("listitem"));
    fireEvent.click(screen.getByRole("menuitem", { name: /copy ssh command/i }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("ssh alice@example.com"),
    );
  });

  it("Delete is rendered with the destructive class", () => {
    render(
      <ConnectionList
        connections={[direct]}
        credentials={[cred]}
        onEdit={vi.fn()}
        onClone={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("listitem"));
    expect(screen.getByRole("menuitem", { name: /delete/i })).toHaveClass(
      "text-destructive",
    );
  });
});
