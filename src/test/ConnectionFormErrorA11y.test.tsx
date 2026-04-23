import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConnectionForm } from "@/components/ConnectionForm";

describe("ConnectionForm error a11y", () => {
  it("renders submit error inside a role=alert region with aria-live", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("Backend exploded"));
    render(
      <ConnectionForm
        open
        onOpenChange={vi.fn()}
        credentials={[
          {
            id: "c1",
            name: "default",
            username: "ubuntu",
            type: "password",
            password: "x",
          },
        ]}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText(/name/i), {
      target: { value: "prod" },
    });
    fireEvent.change(screen.getByLabelText(/host/i), {
      target: { value: "1.2.3.4" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert).toHaveTextContent("Backend exploded");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    // Submit button should reference the error so SR users can hear context.
    expect(
      screen.getByRole("button", { name: /create/i }),
    ).toHaveAttribute("aria-describedby", alert.id);
  });
});
