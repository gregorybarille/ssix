import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { ConnectionForm } from "@/components/ConnectionForm";

/*
 * Audit-3 follow-up P0#1: the connection-form color picker MUST be
 * a Radix RadioGroup (per AGENTS.md). These tests pin the structural
 * a11y contract: a single radiogroup labeled "Color", N+1 radio
 * options (None + every OPEN_COLOR), aria-label on each swatch so
 * AT users hear the color name, and one option in the checked state.
 *
 * We do NOT test arrow-key navigation here — Radix RovingFocusGroup
 * timing is fragile in jsdom (already documented in AGENTS.md
 * notes). The structural a11y is what matters; navigation is
 * covered by Radix's own e2e suite.
 */
describe("ConnectionForm color picker a11y", () => {
  function renderForm() {
    return render(
      <ConnectionForm
        open
        onOpenChange={vi.fn()}
        credentials={[]}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );
  }

  it("color section is a radiogroup with a labeled name", () => {
    renderForm();
    const group = screen.getByRole("radiogroup", { name: /color/i });
    expect(group).toBeInTheDocument();
  });

  it("includes a None option that is selected by default", () => {
    renderForm();
    const group = screen.getByRole("radiogroup", { name: /color/i });
    const none = within(group).getByRole("radio", { name: /no color/i });
    expect(none).toHaveAttribute("aria-checked", "true");
  });

  it("each color swatch is a radio with an accessible name", () => {
    renderForm();
    const group = screen.getByRole("radiogroup", { name: /color/i });
    const radios = within(group).getAllByRole("radio");
    // At least None + a handful of Open Colors. Each must have an
    // accessible name (aria-label or visible text) — i.e. be
    // discoverable in queryByRole({ name }) without falling through
    // to the title attribute.
    expect(radios.length).toBeGreaterThan(5);
    for (const r of radios) {
      const name = r.getAttribute("aria-label") ?? r.textContent ?? "";
      expect(name.trim().length).toBeGreaterThan(0);
    }
  });

  it("selecting a swatch updates aria-checked", () => {
    renderForm();
    const group = screen.getByRole("radiogroup", { name: /color/i });
    const blue = within(group).getByRole("radio", { name: /blue/i });
    expect(blue).toHaveAttribute("aria-checked", "false");
    fireEvent.click(blue);
    expect(blue).toHaveAttribute("aria-checked", "true");
    // None goes back to unchecked.
    expect(
      within(group).getByRole("radio", { name: /no color/i }),
    ).toHaveAttribute("aria-checked", "false");
  });
});
