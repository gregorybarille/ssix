import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContextMenu, useContextMenu } from "@/components/ContextMenu";

const baseItems = [
  { label: "Connect", onClick: vi.fn() },
  { label: "Edit", onClick: vi.fn() },
  { separator: true } as const,
  { label: "Delete", onClick: vi.fn(), destructive: true },
];

describe("ContextMenu (generic primitive)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all enabled items as menuitems and skips separators", () => {
    render(
      <ContextMenu position={{ x: 10, y: 10 }} onClose={vi.fn()} items={baseItems} />,
    );
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("invokes the item's onClick and closes when clicked", async () => {
    const onClose = vi.fn();
    const onConnect = vi.fn();
    render(
      <ContextMenu
        position={{ x: 10, y: 10 }}
        onClose={onClose}
        items={[{ label: "Connect", onClick: onConnect }]}
      />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Connect" }));
    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() => expect(onConnect).toHaveBeenCalledOnce());
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <ContextMenu position={{ x: 10, y: 10 }} onClose={onClose} items={baseItems} />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on outside click", () => {
    const onClose = vi.fn();
    render(
      <div>
        <ContextMenu position={{ x: 10, y: 10 }} onClose={onClose} items={baseItems} />
        <button data-testid="outside">outside</button>
      </div>,
    );
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("moves focus with ArrowDown / ArrowUp and skips disabled items", async () => {
    const user = userEvent.setup();
    const items = [
      { label: "Connect", onClick: vi.fn() },
      { label: "Edit", onClick: vi.fn(), disabled: true },
      { label: "Delete", onClick: vi.fn() },
    ];
    render(
      <ContextMenu position={{ x: 10, y: 10 }} onClose={vi.fn()} items={items} />,
    );
    // First enabled item should be focused on mount.
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Connect" })).toHaveFocus(),
    );
    await user.keyboard("{ArrowDown}");
    // Edit is disabled — focus jumps over it to Delete.
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    // Wraps back to Connect.
    expect(screen.getByRole("menuitem", { name: "Connect" })).toHaveFocus();
  });

  it("renders destructive items with the destructive color class", () => {
    render(
      <ContextMenu
        position={{ x: 10, y: 10 }}
        onClose={vi.fn()}
        items={[{ label: "Delete", onClick: vi.fn(), destructive: true }]}
      />,
    );
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveClass(
      "text-destructive",
    );
  });

  it("disabled items don't fire onClick when clicked", () => {
    const onClick = vi.fn();
    render(
      <ContextMenu
        position={{ x: 10, y: 10 }}
        onClose={vi.fn()}
        items={[{ label: "Edit", onClick, disabled: true }]}
      />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("useContextMenu", () => {
  function Harness() {
    const ctx = useContextMenu();
    return (
      <>
        <button
          data-testid="trigger"
          onContextMenu={ctx.open}
          onKeyDown={ctx.onKeyDown}
        >
          right-click me
        </button>
        {ctx.state && (
          <ContextMenu
            position={ctx.state}
            onClose={ctx.close}
            items={[{ label: "Hello", onClick: vi.fn() }]}
          />
        )}
      </>
    );
  }

  it("opens on contextmenu and closes via Escape", () => {
    render(<Harness />);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByTestId("trigger"), {
      clientX: 50,
      clientY: 60,
    });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens via Shift+F10 anchored to the trigger element (WCAG 2.1.1)", async () => {
    render(<Harness />);
    const trigger = screen.getByTestId("trigger");
    trigger.focus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });

  it("opens via the dedicated ContextMenu key", async () => {
    render(<Harness />);
    const trigger = screen.getByTestId("trigger");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ContextMenu" });
    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });

  it("ignores plain F10 (no Shift) so menubar shortcuts pass through", () => {
    render(<Harness />);
    const trigger = screen.getByTestId("trigger");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "F10" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("returns focus to the opening trigger when the menu closes", async () => {
    render(<Harness />);
    const trigger = screen.getByTestId("trigger");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(trigger, { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });
});
