import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConnectionForm } from "@/components/ConnectionForm";
import type { Credential } from "@/types";

const credentials: Credential[] = [
  { id: "c1", name: "default", username: "ubuntu", type: "password", password: "x" },
];

describe("ConnectionForm port validation", () => {
  it("rejects out-of-range port and surfaces inline aria-invalid error", async () => {
    const onSubmit = vi.fn();
    render(
      <ConnectionForm
        open
        onOpenChange={vi.fn()}
        credentials={credentials}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText(/host \*/i), { target: { value: "1.1.1.1" } });
    const portInput = screen.getByLabelText(/^port$/i);
    fireEvent.change(portInput, { target: { value: "99999" } });
    expect(portInput).toHaveAttribute("aria-invalid", "true");
    const inlineError = screen.getByText(/between 1 and 65535/i);
    expect(inlineError).toHaveAttribute("role", "alert");
    expect(portInput).toHaveAttribute("aria-describedby", inlineError.id);

    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => {
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  it("rejects non-numeric port without silently coercing to 22", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ConnectionForm
        open
        onOpenChange={vi.fn()}
        credentials={credentials}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText(/host \*/i), { target: { value: "1.1.1.1" } });
    fireEvent.change(screen.getByLabelText(/^port$/i), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => {
      expect(screen.getByText(/whole number/i)).toBeInTheDocument();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the user-typed port verbatim (no fallback to 22)", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ConnectionForm
        open
        onOpenChange={vi.fn()}
        credentials={credentials}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText(/host \*/i), { target: { value: "1.1.1.1" } });
    fireEvent.change(screen.getByLabelText(/^port$/i), { target: { value: "2222" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.port).toBe(2222);
  });
});
