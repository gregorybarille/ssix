import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LayoutToggle } from "@/components/ui/layout-toggle";

/*
 * Audit-3 follow-up P1#1: the toggle is icon-only, so each button
 * MUST have an explicit aria-label (title= alone is not exposed
 * reliably to AT and not at all on touch devices). These tests query
 * by accessible name (`getByRole("button", { name })`) rather than
 * by title= so they fail loudly if the aria-label ever regresses.
 */
describe("LayoutToggle", () => {
  it("sets aria-pressed=true on List button and false on Tiles when value is list", () => {
    render(<LayoutToggle value="list" onChange={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "List view" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Tile view" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("sets aria-pressed=true on Tiles button and false on List when value is tile", () => {
    render(<LayoutToggle value="tile" onChange={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "List view" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: "Tile view" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onChange with 'list' when the List button is clicked", () => {
    const onChange = vi.fn();
    render(<LayoutToggle value="tile" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("list");
  });

  it("calls onChange with 'tile' when the Tiles button is clicked", () => {
    const onChange = vi.fn();
    render(<LayoutToggle value="list" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Tile view" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("tile");
  });

  it("accepts an optional className prop without error", () => {
    const { container } = render(
      <LayoutToggle value="list" onChange={vi.fn()} className="extra-class" />,
    );
    expect(container.firstChild).toHaveClass("extra-class");
  });

  it("hides the decorative lucide icons from AT (aria-hidden)", () => {
    /*
     * Audit-3 follow-up P1#1: the lucide List/LayoutGrid glyphs are
     * decorative — the button's accessible name comes from
     * aria-label. Without aria-hidden, lucide's auto-derived
     * "list" / "layout grid" names would be appended to the
     * announcement and double up the label.
     */
    const { container } = render(
      <LayoutToggle value="list" onChange={vi.fn()} />,
    );
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBe(2);
    svgs.forEach((svg) =>
      expect(svg.getAttribute("aria-hidden")).toBe("true"),
    );
  });
});
