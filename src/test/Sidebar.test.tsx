import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sidebar } from "@/components/Sidebar";

describe("Sidebar", () => {
  it("renders nav items", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    expect(screen.getByTitle("Connections")).toBeInTheDocument();
    expect(screen.getByTitle("Credentials")).toBeInTheDocument();
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
});
