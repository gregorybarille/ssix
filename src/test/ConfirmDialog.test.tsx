import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";

describe("ConfirmDialog", () => {
  it("renders title and description when open", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete it?"
        description="This is permanent."
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Delete it?" })).toBeInTheDocument();
    expect(screen.getByText("This is permanent.")).toBeInTheDocument();
  });

  it("default-focuses the cancel button (never the destructive action)", async () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete it?"
        description="x"
        variant="destructive"
        confirmLabel="Delete"
        onConfirm={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
  });

  it("calls onConfirm and closes on confirm click", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="x"
        description="y"
        confirmLabel="Yes"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("does not call onConfirm when cancel is clicked", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="x"
        description="y"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  /*
   * Audit-3 #2: Radix Dialog automatically returns focus to the
   * element that had focus when the dialog opened. Verify this
   * holds for our open-from-state usage pattern (no DialogTrigger).
   * If this test ever regresses, the most likely cause is the parent
   * unmounting the trigger between open and close — fix the parent,
   * not Radix.
   */
  it("returns focus to the trigger button after closing", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open dialog
          </button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title="Confirm?"
            description="x"
            confirmLabel="Yes"
            onConfirm={() => {}}
          />
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    trigger.focus();
    await user.click(trigger);
    // Dialog opens and focus moves into it (cancel button).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    // Close via Cancel.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    // Focus must come back to the original trigger.
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("returns focus to the trigger after Escape closes the dialog", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open dialog
          </button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title="Confirm?"
            description="x"
            onConfirm={() => {}}
          />
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    trigger.focus();
    await user.click(trigger);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
