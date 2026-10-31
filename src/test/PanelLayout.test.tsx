import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
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

  it("shows confirmations as a card at the top of the panel column", () => {
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
    expect(slot()).toContainElement(card);
    expect(card).toHaveAttribute("data-kind", "confirm");
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
