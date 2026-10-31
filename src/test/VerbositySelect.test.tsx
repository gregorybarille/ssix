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

describe("ConnectionForm verbosity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a verbosity level label", () => {
    render(<ConnectionForm {...defaultProps} />);
    expect(screen.getByText(/verbosity level/i)).toBeInTheDocument();
  });

  it("defaults to quiet", () => {
    render(<ConnectionForm {...defaultProps} />);
    const matches = screen.getAllByText(/Quiet \(default\)/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("populates verbosity from an existing connection", () => {
    const conn: Connection = {
      id: "c1",
      name: "my-server",
      host: "example.com",
      port: 22,
      type: "direct",
      verbosity: 1,
    };
    render(<ConnectionForm {...defaultProps} connection={conn} />);
    const matches = screen.getAllByText(/-v \(connection steps\)/);
    expect(matches.length).toBeGreaterThan(0);
  });
});
