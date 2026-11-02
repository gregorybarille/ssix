import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** A menu whose items do what the tab bar's do: open a picker, or open what wants the keyboard. */
function App({ onPick }: { onPick?: () => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <input data-testid="elsewhere" />
      <DropdownMenu>
        <DropdownMenuTrigger data-testid="trigger">Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem data-testid="pick" onClick={onPick}>
            Pick
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="open-picker" onClick={() => setOpen(true)}>
            Open
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent kind="palette">
          <DialogHeader>
            <DialogTitle>Title</DialogTitle>
            <DialogDescription>Description</DialogDescription>
          </DialogHeader>
          <input data-testid="inside" autoFocus />
        </DialogContent>
      </Dialog>
    </>
  );
}

function openMenu() {
  const trigger = screen.getByTestId("trigger");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
}

/** Radix returns focus from a timer, once the menu is gone. */
const menuGone = async () => {
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("focus when a menu closes", () => {
  it("goes back to the menu's button", async () => {
    render(<App />);
    openMenu();
    fireEvent.click(await screen.findByTestId("pick"));
    await menuGone();
    expect(screen.getByTestId("trigger")).toHaveFocus();
  });

  it("stays with what took it while the menu closed", async () => {
    // Queued before the timer the menu sets as it goes, and after its focus trap has gone.
    render(<App onPick={() => setTimeout(() => screen.getByTestId("elsewhere").focus(), 0)} />);
    openMenu();
    fireEvent.click(await screen.findByTestId("pick"));
    await menuGone();
    expect(screen.getByTestId("elsewhere")).toHaveFocus();
  });

  it("stays in a dialog an item opened, and goes back to the button when that closes", async () => {
    render(<App />);
    openMenu();
    fireEvent.click(await screen.findByTestId("open-picker"));
    await menuGone();
    const inside = await screen.findByTestId("inside");
    expect(inside).toHaveFocus();

    fireEvent.keyDown(inside, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("inside")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("trigger")).toHaveFocus());
  });
});
