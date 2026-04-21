import React from "react";
import { render, screen } from "@testing-library/react";
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
