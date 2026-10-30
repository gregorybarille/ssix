import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConnectionForm } from "@/components/ConnectionForm";
import { Connection, Credential } from "@/types";
import { renderInPanel } from "./panel";

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

  it("opens in the side panel, beside the view", () => {
    const { slot } = renderInPanel(<ConnectionForm {...defaultProps} />);
    const panel = screen.getByRole("dialog", { name: /new connection/i });
    expect(slot()).toContainElement(panel);
    expect(screen.getByTestId("view")).not.toContainElement(panel);
  });

  it("stays open while the user works in the view beside it", () => {
    const onOpenChange = vi.fn();
    renderInPanel(<ConnectionForm {...defaultProps} onOpenChange={onOpenChange} />);
    fireEvent.pointerDown(screen.getByTestId("view"));
    fireEvent.focusIn(screen.getByTestId("view"));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("focuses the first field and closes on Escape", async () => {
    const onOpenChange = vi.fn();
    renderInPanel(<ConnectionForm {...defaultProps} onOpenChange={onOpenChange} />);

    await waitFor(() => expect(screen.getByLabelText(/connection name/i)).toHaveFocus());

    fireEvent.keyDown(screen.getByLabelText(/connection name/i), { key: "Escape" });
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
