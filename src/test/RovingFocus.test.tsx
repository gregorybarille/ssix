import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConnectionList } from "@/components/ConnectionList";
import { CredentialList } from "@/components/CredentialList";
import type { Connection, Credential } from "@/types";

const cred: Credential = {
  id: "c1",
  name: "root",
  username: "root",
  type: "password",
  password: "x",
};

const conns: Connection[] = [
  { id: "1", name: "Alpha", type: "direct", host: "a.example", port: 22, credential_id: "c1" },
  { id: "2", name: "Bravo", type: "direct", host: "b.example", port: 22, credential_id: "c1" },
  { id: "3", name: "Charlie", type: "direct", host: "c.example", port: 22, credential_id: "c1" },
];

describe("ConnectionList keyboard navigation", () => {
  it("uses roving tabindex (only first item tabbable initially)", () => {
    render(
      <ConnectionList
        connections={conns}
        credentials={[cred]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        onConnect={vi.fn()}
      />,
    );
    const list = screen.getByRole("list", { name: /connections/i });
    const items = list.querySelectorAll<HTMLElement>('[role="listitem"]');
    expect(items).toHaveLength(3);
    expect(items[0].tabIndex).toBe(0);
    expect(items[1].tabIndex).toBe(-1);
    expect(items[2].tabIndex).toBe(-1);
  });

  it("ArrowDown / ArrowUp moves the roving focus", async () => {
    render(
      <ConnectionList
        connections={conns}
        credentials={[cred]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        onConnect={vi.fn()}
      />,
    );
    const list = screen.getByRole("list", { name: /connections/i });
    const items = list.querySelectorAll<HTMLElement>('[role="listitem"]');
    items[0].focus();
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    // microtask flushes the focus call
    await Promise.resolve();
    expect(document.activeElement).toBe(items[1]);
    expect(items[1].tabIndex).toBe(0);
    expect(items[0].tabIndex).toBe(-1);
    fireEvent.keyDown(items[1], { key: "ArrowUp" });
    await Promise.resolve();
    expect(document.activeElement).toBe(items[0]);
  });

  it("Home / End jump to ends, ArrowDown wraps from last to first", async () => {
    render(
      <ConnectionList
        connections={conns}
        credentials={[cred]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        onConnect={vi.fn()}
      />,
    );
    const items = screen.getAllByRole("listitem");
    items[0].focus();
    fireEvent.keyDown(items[0], { key: "End" });
    await Promise.resolve();
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2], { key: "ArrowDown" });
    await Promise.resolve();
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: "End" });
    await Promise.resolve();
    fireEvent.keyDown(items[2], { key: "Home" });
    await Promise.resolve();
    expect(document.activeElement).toBe(items[0]);
  });

  it("Enter activates onSelect when provided, else onConnect", () => {
    const onSelect = vi.fn();
    const onConnect = vi.fn();
    const { rerender } = render(
      <ConnectionList
        connections={conns}
        credentials={[cred]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        onSelect={onSelect}
        onConnect={onConnect}
      />,
    );
    let items = screen.getAllByRole("listitem");
    items[1].focus();
    fireEvent.keyDown(items[1], { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(conns[1]);
    expect(onConnect).not.toHaveBeenCalled();

    rerender(
      <ConnectionList
        connections={conns}
        credentials={[cred]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        onConnect={onConnect}
      />,
    );
    items = screen.getAllByRole("listitem");
    items[2].focus();
    fireEvent.keyDown(items[2], { key: " " });
    expect(onConnect).toHaveBeenCalledWith(conns[2]);
  });

  it("does not intercept keys typed inside nested controls (action buttons)", () => {
    const onSelect = vi.fn();
    render(
      <ConnectionList
        connections={conns}
        credentials={[cred]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClone={vi.fn()}
        onSelect={onSelect}
        onConnect={vi.fn()}
      />,
    );
    const items = screen.getAllByRole("listitem");
    const editButton = items[0].querySelector<HTMLButtonElement>('[aria-label^="Edit"]');
    expect(editButton).toBeTruthy();
    editButton!.focus();
    fireEvent.keyDown(editButton!, { key: "Enter" });
    // onSelect (row activation) MUST NOT fire — Enter on a button activates the button
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("CredentialList keyboard navigation", () => {
  const creds: Credential[] = [
    { id: "a", name: "alpha", username: "u1", type: "password", password: "p" },
    { id: "b", name: "bravo", username: "u2", type: "ssh_key", private_key_path: "~/.ssh/id" },
  ];

  it("uses roving tabindex and Enter triggers edit", () => {
    const onEdit = vi.fn();
    render(<CredentialList credentials={creds} onEdit={onEdit} onDelete={vi.fn()} />);
    const list = screen.getByRole("list", { name: /credentials/i });
    const items = list.querySelectorAll<HTMLElement>('[role="listitem"]');
    expect(items).toHaveLength(2);
    expect(items[0].tabIndex).toBe(0);
    expect(items[1].tabIndex).toBe(-1);

    items[0].focus();
    fireEvent.keyDown(items[0], { key: "Enter" });
    expect(onEdit).toHaveBeenCalledWith(creds[0]);
  });

  it("ArrowDown moves focus and ArrowUp wraps to last", async () => {
    render(<CredentialList credentials={creds} onEdit={vi.fn()} onDelete={vi.fn()} />);
    const items = screen.getAllByRole("listitem");
    items[0].focus();
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    await Promise.resolve();
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: "ArrowDown" });
    await Promise.resolve();
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: "ArrowUp" });
    await Promise.resolve();
    expect(document.activeElement).toBe(items[1]);
  });
});
