import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LayoutToggle } from "@/components/ui/layout-toggle";

describe("LayoutToggle", () => {
  it("sets aria-pressed=true on List button and false on Tiles when value is list", () => {
    render(<LayoutToggle value="list" onChange={vi.fn()} />);
    expect(screen.getByTitle("List")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTitle("Tiles")).toHaveAttribute("aria-pressed", "false");
  });

  it("sets aria-pressed=true on Tiles button and false on List when value is tile", () => {
    render(<LayoutToggle value="tile" onChange={vi.fn()} />);
    expect(screen.getByTitle("List")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTitle("Tiles")).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onChange with 'list' when the List button is clicked", () => {
    const onChange = vi.fn();
    render(<LayoutToggle value="tile" onChange={onChange} />);
    fireEvent.click(screen.getByTitle("List"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("list");
  });

  it("calls onChange with 'tile' when the Tiles button is clicked", () => {
    const onChange = vi.fn();
    render(<LayoutToggle value="list" onChange={onChange} />);
    fireEvent.click(screen.getByTitle("Tiles"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("tile");
  });

  it("accepts an optional className prop without error", () => {
    const { container } = render(
      <LayoutToggle value="list" onChange={vi.fn()} className="extra-class" />,
    );
    expect(container.firstChild).toHaveClass("extra-class");
  });
});
