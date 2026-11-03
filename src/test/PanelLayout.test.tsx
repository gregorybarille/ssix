import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ConnectPicker } from "@/components/ConnectPicker";
import { ConnectionForm } from "@/components/ConnectionForm";
import { useDialogsStore } from "@/store/useDialogsStore";
import type { Connection } from "@/types";
import { renderInPanel } from "./panel";

const web: Connection = { id: "c1", name: "web", host: "10.0.0.1", port: 22, type: "direct" };
const db: Connection = { id: "c2", name: "db", host: "10.0.0.2", port: 22, type: "direct" };

/** The connection form wired to the dialogs store, as ConnectionsView does. */
function Form() {
  const { connFormOpen, editingConn, setConnFormOpen } = useDialogsStore();
  return (
    <ConnectionForm
      open={connFormOpen}
      onOpenChange={setConnFormOpen}
      connection={editingConn}
      credentials={[]}
      onSubmit={vi.fn()}
    />
  );
}

describe("Side panel layout", () => {
  beforeEach(() => {
    useDialogsStore.setState({
      connFormOpen: false,
      editingConn: null,
      cloningConn: null,
      connFormGuard: null,
    });
  });

  it("shows confirmations in the middle of the app, not in the panel column", () => {
    const { slot } = renderInPanel(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete web?"
        description="It is removed for good."
        onConfirm={vi.fn()}
        testId="confirm"
      />,
    );
    const card = screen.getByTestId("confirm");
    expect(card).toHaveAttribute("data-kind", "confirm");
    expect(slot()).not.toContainElement(card);
    expect(card.className).toMatch(/top-\[50%\]/);
    expect(card.className).toMatch(/left-\[50%\]/);
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).toBeInTheDocument();
    // Fading out, it would take the click meant for what is behind it.
    expect(overlay?.className).not.toMatch(/data-\[state=closed\]/);
  });

  it("keeps the app out of reach until a confirmation is answered", async () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <>
        <button>Behind</button>
        <ConfirmDialog
          open
          onOpenChange={onOpenChange}
          title="Delete web?"
          description="It is removed for good."
          onConfirm={onConfirm}
          testId="confirm"
        />
      </>,
    );
    // Hidden from assistive technology, and clicks outside answer nothing.
    expect(screen.queryByRole("button", { name: "Behind" })).not.toBeInTheDocument();
    fireEvent.pointerDown(document.querySelector('[data-slot="dialog-overlay"]')!);
    fireEvent.click(document.querySelector('[data-slot="dialog-overlay"]')!);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    // Enter on what has focus cancels: it is never the destructive button.
    expect(screen.getByTestId("confirm-cancel")).toHaveFocus();
    fireEvent.keyDown(screen.getByTestId("confirm"), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the quick-connect palette centred over the app", () => {
    const { slot } = renderInPanel(
      <ConnectPicker
        open
        onOpenChange={vi.fn()}
        connections={[]}
        credentials={[]}
        onConnect={vi.fn()}
      />,
    );
    const palette = screen.getByRole("dialog");
    expect(palette).toHaveAttribute("data-kind", "palette");
    expect(slot()).not.toContainElement(palette);
  });

  it("asks before another row's Edit replaces unsaved changes", async () => {
    const user = userEvent.setup();
    useDialogsStore.getState().openEditConnection(web);
    renderInPanel(<Form />);
    const name = await screen.findByLabelText(/connection name/i);
    await user.clear(name);
    await user.type(name, "web-renamed");

    useDialogsStore.getState().openEditConnection(db);
    await screen.findByRole("dialog", { name: /discard unsaved changes/i });
    expect(useDialogsStore.getState().editingConn).toBe(web);

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(useDialogsStore.getState().editingConn).toBe(db));
    await waitFor(() => expect(screen.getByLabelText(/connection name/i)).toHaveValue("db"));
  });

  it("switches straight away when the open form is unchanged", async () => {
    useDialogsStore.getState().openEditConnection(web);
    renderInPanel(<Form />);
    await screen.findByLabelText(/connection name/i);
    useDialogsStore.getState().openEditConnection(db);
    expect(useDialogsStore.getState().editingConn).toBe(db);
    expect(screen.queryByRole("dialog", { name: /discard unsaved changes/i })).toBeNull();
  });
});
