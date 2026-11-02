import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, screen, within } from "@testing-library/react";
import { Sidebar } from "@/components/Sidebar";
import { VIEWS } from "@/lib/views";

const { extraView } = vi.hoisted(() => ({
  extraView: {
    id: "probe_view",
    label: "Probe",
    description: "A view only this test knows",
    placement: "main",
  },
}));

// A view added to the table: everything the sidebar shows must follow from it.
vi.mock("@/lib/views", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/views")>();
  return {
    ...actual,
    VIEWS: [...actual.VIEWS, { ...extraView, icon: actual.VIEWS[0].icon }],
  };
});

const tableViews = VIEWS.filter((view) => view.id !== (extraView.id as string));

describe("view table", () => {
  it("has unique ids and says what every view is for", () => {
    const ids = tableViews.map((view) => view.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const view of tableViews) {
      expect(view.label).not.toBe("");
      expect(view.description).not.toBe("");
    }
  });

  it("routes every view: a lazy component, or its own branch in App.tsx", () => {
    const app = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
    for (const view of tableViews) {
      if (!view.component) expect(app).toContain(`view === "${view.id}"`);
    }
  });
});

describe("Sidebar from the view table", () => {
  const buttonIds = () =>
    within(screen.getByRole("navigation", { name: /primary/i }))
      .getAllByRole("button")
      .map((button) => button.dataset.testid);

  // Checks relative order, so a stream adding a real view does not edit this list.
  it("keeps the buttons in place, with a new main view after the existing ones", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} terminalCount={1} />);
    const fixed = [
      "nav-connections",
      "nav-forwards",
      "nav-credentials",
      "nav-scripts",
      "nav-logs",
      "nav-terminals",
      "nav-git-sync",
    ];
    const ids = buttonIds();
    expect(ids.filter((id) => fixed.includes(id ?? ""))).toEqual(fixed);
    expect(ids.indexOf("nav-probe-view")).toBe(ids.indexOf("nav-terminals") - 1);
  });

  it("gives Settings no sidebar button: it lives in the title bar", () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("shows only the table's description in a tooltip without a shortcut", async () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    const button = screen.getByTestId("nav-logs");
    act(() => button.focus());
    const tooltip = await screen.findByTestId("nav-logs-tooltip");
    expect(tooltip.querySelectorAll("p")).toHaveLength(2);
  });

  it("adds a view's shortcut hint to its tooltip", async () => {
    render(<Sidebar active="connections" onNavigate={vi.fn()} />);
    const button = screen.getByTestId("nav-probe-view");
    expect(button).toHaveAttribute("aria-label", "Probe");
    act(() => button.focus());
    const tooltip = await screen.findByTestId("nav-probe-view-tooltip");
    expect(within(tooltip).getByText("A view only this test knows")).toBeInTheDocument();
  });
});
