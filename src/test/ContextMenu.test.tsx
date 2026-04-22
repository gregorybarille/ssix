import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContextMenu } from "@/components/ContextMenu";

const defaultProps = {
  position: { x: 100, y: 200 },
  onClose: vi.fn(),
  onTakeScreenshot: vi.fn(),
};

describe("ContextMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the Take Screenshot item", () => {
    render(<ContextMenu {...defaultProps} />);
    expect(screen.getByRole("menuitem", { name: /take screenshot/i })).toBeInTheDocument();
  });

  it("calls onTakeScreenshot and onClose when the item is clicked", () => {
    render(<ContextMenu {...defaultProps} />);
    fireEvent.click(screen.getByRole("menuitem", { name: /take screenshot/i }));
    expect(defaultProps.onTakeScreenshot).toHaveBeenCalledOnce();
    expect(defaultProps.onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Escape is pressed", () => {
    render(<ContextMenu {...defaultProps} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(defaultProps.onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when clicking outside the menu", () => {
    render(
      <div>
        <ContextMenu {...defaultProps} />
        <button data-testid="outside">outside</button>
      </div>
    );
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(defaultProps.onClose).toHaveBeenCalledOnce();
  });
});
