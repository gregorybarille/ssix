import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionForm } from "@/components/ConnectionForm";
import { CredentialForm } from "@/components/CredentialForm";
import type { Credential } from "@/types";

const credentials: Credential[] = [
  { id: "c1", name: "default", username: "ubuntu", type: "password", password: "x" },
];

describe("ConnectionForm required-field inline errors", () => {
  it("shows inline aria-invalid error on empty Name when submitting", async () => {
    const onSubmit = vi.fn();
    render(
      <ConnectionForm
        open
        onOpenChange={vi.fn()}
        credentials={credentials}
        onSubmit={onSubmit}
      />,
    );
    // Browser HTML5 required would normally block, but our tests bypass
    // it via fireEvent.submit on the form.
    const form = screen.getByRole("button", { name: /create/i }).closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => {
      const nameInput = screen.getByLabelText(/connection name/i);
      expect(nameInput).toHaveAttribute("aria-invalid", "true");
    });
    const nameError = screen.getByText(/connection name is required/i);
    expect(nameError).toHaveAttribute("role", "alert");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows inline error on empty Host (direct mode)", async () => {
    const onSubmit = vi.fn();
    render(
      <ConnectionForm
        open
        onOpenChange={vi.fn()}
        credentials={credentials}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText(/connection name/i), {
      target: { value: "x" },
    });
    const form = screen.getByRole("button", { name: /create/i }).closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => {
      const hostInput = screen.getByLabelText(/host \*/i);
      expect(hostInput).toHaveAttribute("aria-invalid", "true");
    });
    expect(screen.getByText(/host is required/i)).toBeInTheDocument();
  });

  it("clears the inline error as soon as the user types", async () => {
    render(
      <ConnectionForm
        open
        onOpenChange={vi.fn()}
        credentials={credentials}
        onSubmit={vi.fn()}
      />,
    );
    const form = screen.getByRole("button", { name: /create/i }).closest("form")!;
    fireEvent.submit(form);
    await waitFor(() =>
      expect(screen.getByText(/connection name is required/i)).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText(/connection name/i), {
      target: { value: "h" },
    });
    expect(
      screen.queryByText(/connection name is required/i),
    ).not.toBeInTheDocument();
  });
});

describe("CredentialForm required-field inline errors", () => {
  it("shows inline aria-invalid errors on empty Name and Username", async () => {
    const onSubmit = vi.fn();
    render(<CredentialForm open onOpenChange={vi.fn()} onSubmit={onSubmit} />);
    const form = screen
      .getByRole("button", { name: /create credential|create/i })
      .closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(screen.getByLabelText(/credential name/i)).toHaveAttribute(
        "aria-invalid",
        "true",
      );
    });
    expect(screen.getByLabelText(/^username/i)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/credential name is required/i)).toBeInTheDocument();
    expect(screen.getByText(/^username is required/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows inline error when Private Key Path is empty for ssh_key type", async () => {
    const user = userEvent.setup();
    render(<CredentialForm open onOpenChange={vi.fn()} onSubmit={vi.fn()} />);
    await user.type(screen.getByLabelText(/credential name/i), "k");
    await user.type(screen.getByLabelText(/^username/i), "u");
    await user.click(screen.getByRole("tab", { name: /ssh key/i }));
    const form = screen
      .getByRole("button", { name: /create credential|create/i })
      .closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(screen.getByLabelText(/private key path/i)).toHaveAttribute(
        "aria-invalid",
        "true",
      );
    });
    expect(screen.getByText(/private key path is required/i)).toBeInTheDocument();
  });
});
