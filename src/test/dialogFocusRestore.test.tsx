import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** A dialog that stays mounted while closed, as the quick connect picker does. */
function App({ open }: { open: boolean }) {
  return (
    <>
      <button data-testid="first">first</button>
      <button data-testid="second">second</button>
      <input data-testid="elsewhere" />
      <Dialog open={open}>
        <DialogContent kind="palette">
          <DialogHeader>
            <DialogTitle>Title</DialogTitle>
            <DialogDescription>Description</DialogDescription>
          </DialogHeader>
          <input data-testid="inside" />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Radix restores focus from a timer, once the content is gone. */
const settled = () => waitFor(() => expect(screen.queryByTestId("inside")).toBeNull());
const afterRestore = async () => {
  await settled();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("focus when a dialog closes", () => {
  it("goes back to what had it when the dialog opened, not when it first rendered", async () => {
    const view = render(<App open={false} />);
    screen.getByTestId("first").focus();
    view.rerender(<App open={false} />);

    screen.getByTestId("second").focus();
    view.rerender(<App open />);
    await waitFor(() => expect(screen.getByTestId("second")).not.toHaveFocus());

    view.rerender(<App open={false} />);
    await afterRestore();
    expect(screen.getByTestId("second")).toHaveFocus();
  });

  it("follows each opening, not only the first", async () => {
    const view = render(<App open={false} />);
    for (const id of ["first", "second", "first"]) {
      screen.getByTestId(id).focus();
      view.rerender(<App open />);
      await waitFor(() => expect(screen.getByTestId(id)).not.toHaveFocus());
      view.rerender(<App open={false} />);
      await afterRestore();
      expect(screen.getByTestId(id)).toHaveFocus();
    }
  });

  it("stays with whatever took it while the dialog closed", async () => {
    const view = render(<App open={false} />);
    screen.getByTestId("first").focus();
    view.rerender(<App open />);
    await waitFor(() => expect(screen.getByTestId("first")).not.toHaveFocus());

    view.rerender(<App open={false} />);
    screen.getByTestId("elsewhere").focus();
    await afterRestore();
    expect(screen.getByTestId("elsewhere")).toHaveFocus();
  });
});
