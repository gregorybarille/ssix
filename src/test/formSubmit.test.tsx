import { describe, it, expect, vi } from "vitest";
import { createPortal } from "react-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { submitWithoutReset } from "@/lib/formSubmit";

describe("submitWithoutReset", () => {
  it("runs the action and leaves the form's fields as the user left them", async () => {
    const action = vi.fn();
    render(
      <form data-testid="form" onSubmit={submitWithoutReset(action)}>
        <input aria-label="field" defaultValue="initial" />
      </form>,
    );
    const field = screen.getByLabelText("field") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "edited" } });
    fireEvent.submit(screen.getByTestId("form"));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(field.value).toBe("edited");
  });

  it("ignores a submit bubbling from a form portalled inside it", async () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <form data-testid="outer" onSubmit={submitWithoutReset(outer)}>
        {createPortal(
          <form data-testid="inner" onSubmit={submitWithoutReset(inner)} />,
          document.body,
        )}
      </form>,
    );
    fireEvent.submit(screen.getByTestId("inner"));
    await waitFor(() => expect(inner).toHaveBeenCalledTimes(1));
    expect(outer).not.toHaveBeenCalled();
  });
});
