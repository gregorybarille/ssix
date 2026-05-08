import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConnectionForm } from "@/components/ConnectionForm";
import { Connection, Credential } from "@/types";

const noop = async () => {};
const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  credentials: [] as Credential[],
  onSubmit: noop,
};

describe("ConnectionForm extra_args", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders an additional SSH arguments input", () => {
    render(<ConnectionForm {...defaultProps} />);
    expect(screen.getByLabelText(/additional ssh arguments/i)).toBeInTheDocument();
  });

  it("renders the inline connection panel body outside dialog context", () => {
    render(<ConnectionForm {...defaultProps} inline />);
    expect(screen.getByRole("heading", { name: /new connection/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/host/i)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /new connection/i })).toBeInTheDocument();
    expect(screen.getByTestId("connection-form")).toHaveAttribute("aria-labelledby");
  });

  it("focuses the first field and closes on Escape in inline mode", async () => {
    const onOpenChange = vi.fn();
    render(<ConnectionForm {...defaultProps} inline onOpenChange={onOpenChange} />);

    await waitFor(() => expect(screen.getByLabelText(/connection name/i)).toHaveFocus());

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("populates extra_args from an existing connection", () => {
    const conn: Connection = {
      id: "c1",
      name: "my-server",
      host: "example.com",
      port: 22,
      type: "direct",
      extra_args: "-C",
    };
    render(<ConnectionForm {...defaultProps} connection={conn} />);
    const input = screen.getByLabelText(/additional ssh arguments/i) as HTMLInputElement;
    expect(input.value).toBe("-C");
  });
});
