import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sidebar } from "@/components/Sidebar";

describe("Sidebar", () => {
  it("renders nav items", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    expect(screen.getByTitle("Connections")).toBeInTheDocument();
    expect(screen.getByTitle("Credentials")).toBeInTheDocument();
    expect(screen.getByTitle("Git Sync")).toBeInTheDocument();
  });

  it("highlights the active nav item", () => {
    render(<Sidebar active="credentials" onNavigate={vi.fn()} />);
    const credBtn = screen.getByTitle("Credentials");
    expect(credBtn.className).toContain("bg-accent");
  });

  it("calls onNavigate when clicking a nav item", () => {
    const onNavigate = vi.fn();
    render(<Sidebar active="connections" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByTitle("Credentials"));
    expect(onNavigate).toHaveBeenCalledWith("credentials");
  });

  it("does not show terminal icon when terminalCount is 0", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} terminalCount={0} />);
    expect(screen.queryByTitle(/Terminals/)).not.toBeInTheDocument();
  });

  it("shows terminal icon with badge when terminalCount > 0", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} terminalCount={3} />);
    const termBtn = screen.getByTitle("Terminals (3)");
    expect(termBtn).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("calls onNavigate with 'terminals' when clicking terminal icon", () => {
    const onNavigate = vi.fn();
    render(<Sidebar active="connections" onNavigate={onNavigate} terminalCount={2} />);
    fireEvent.click(screen.getByTitle("Terminals (2)"));
    expect(onNavigate).toHaveBeenCalledWith("terminals");
  });

  it("highlights terminal icon when active", () => {
    render(<Sidebar active="terminals" onNavigate={vi.fn()} terminalCount={1} />);
    const termBtn = screen.getByTitle("Terminals (1)");
    expect(termBtn.className).toContain("bg-accent");
  });

  it("shows git sync at the bottom with pending indicator support", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} gitPending />);
    expect(screen.getByTitle("Git Sync")).toBeInTheDocument();
  });

  it("exposes accessible names on nav buttons", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Connections" })
    ).toBeInTheDocument();
  });

  it("includes badge count in the accessible name when active sessions exist", () => {
    render(
      <Sidebar active="connections" onNavigate={vi.fn()} terminalCount={3} />
    );
    expect(
      screen.getByRole("button", { name: /Terminals, 3 active/i })
    ).toBeInTheDocument();
  });

  it("marks the active item with aria-current", () => {
    render(<Sidebar active="credentials" onNavigate={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Credentials" })
    ).toHaveAttribute("aria-current", "page");
  });

  /*
   * Audit-3 #1: prior implementation buried "(pending changes)" inside
   * an aria-hidden parent, so AT users had no way to distinguish a
   * dirty git state from a clean one. The dot must contribute to the
   * button's accessible name.
   */
  it("includes 'pending changes' in the accessible name when gitPending is true", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} gitPending />);
    expect(
      screen.getByRole("button", { name: /Git Sync, pending changes/i }),
    ).toBeInTheDocument();
  });

  it("does NOT mention pending changes when gitPending is false", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "Git Sync" });
    expect(btn.getAttribute("aria-label")).toBe("Git Sync");
  });

  it("renders nav buttons inside a labeled <nav> landmark", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    // <nav> elements have implicit role="navigation"
    expect(
      screen.getByRole("navigation", { name: /primary/i }),
    ).toBeInTheDocument();
  });

  it("uses type=button on nav buttons (defensive vs implicit form submit)", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "Connections" });
    expect(btn).toHaveAttribute("type", "button");
  });
});
