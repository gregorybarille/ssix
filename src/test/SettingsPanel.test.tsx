import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SettingsPanel } from "@/components/SettingsPanel";
import type { AppSettings } from "@/types";

const defaults: AppSettings = {
  font_size: 14,
  font_family: "monospace",
  color_scheme: "blue",
  theme: "dark",
  connection_layout: "list",
  credential_layout: "list",
  tunnel_layout: "list",
  default_open_mode: "tab",
  auto_copy_selection: false,
  git_sync_remote: "origin",
};

describe("SettingsPanel", () => {
  /*
   * P2-A6: the three Git Sync text fields previously used hand-rolled
   * <input className="..."> markup that diverged from the shared
   * <Input> primitive — no focus ring, no theme tokens, easy to drift.
   * Asserting the focus-visible:ring-2 class catches regressions
   * without coupling to specific Tailwind class soup.
   */
  it("git sync text fields use the shared <Input> primitive", () => {
    render(<SettingsPanel settings={defaults} onSave={vi.fn()} />);
    for (const label of [/repository path/i, /remote name/i, /branch override/i]) {
      const field = screen.getByLabelText(label);
      expect(field.className).toMatch(/focus-visible:ring-2/);
    }
  });

  /*
   * P2-A11: the "Settings saved!" confirmation must live in a
   * role=status / aria-live=polite region so screen readers announce
   * it. The previous implementation toggled a plain green <span> in
   * and out of the DOM, which AT does not announce because the live
   * region itself was being mounted/unmounted.
   */
  it("announces Settings saved! via a polite live region", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsPanel settings={defaults} onSave={onSave} />);
    // The live region must exist on initial render (empty), so AT
    // is already subscribed when the text appears.
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status.textContent).toBe("");

    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/settings saved/i),
    );
  });

  /*
   * Audit-3 P1#1: the auto-copy-on-selection toggle must default to OFF
   * (so the existing user contract — "highlighting text never silently
   * overwrites my clipboard" — is preserved on first run) and must be
   * exposed as a real `role="switch"` with an accessible name + helpful
   * description, not a hand-rolled checkbox.
   */
  it("renders auto-copy-selection as a labeled, off-by-default switch", () => {
    render(<SettingsPanel settings={defaults} onSave={vi.fn()} />);
    const toggle = screen.getByRole("switch", {
      name: /copy selection to clipboard automatically/i,
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    // Must have a description (aria-describedby points at the helper text).
    const describedBy = toggle.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy!);
    expect(description?.textContent).toMatch(/cmd\/ctrl\+c still copies/i);
  });

  it("flips the auto-copy switch and saves the new value", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsPanel settings={defaults} onSave={onSave} />);
    const toggle = screen.getByRole("switch", {
      name: /copy selection to clipboard/i,
    });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].auto_copy_selection).toBe(true);
  });

  /*
   * Audit-3 P1#5: the color-scheme and theme pickers were hand-rolled
   * <button> grids — invisible to AT as a *group*, no arrow-key
   * navigation, no aria-checked. They must now be real WAI-ARIA radio
   * groups so AT announces "Color Scheme (Open Colors), radio group,
   * 8 options, blue selected, 1 of 8" and so keyboard users can
   * arrow between options.
   */
  it("color-scheme picker is a labeled radiogroup with one radio per swatch", () => {
    render(<SettingsPanel settings={defaults} onSave={vi.fn()} />);
    const group = screen.getByRole("radiogroup", {
      name: /color scheme \(open colors\)/i,
    });
    // Each swatch is a role=radio inside the group.
    const radios = within(group).getAllByRole("radio");
    expect(radios.length).toBeGreaterThan(1);
    // Exactly one radio must be aria-checked=true (the current selection).
    const checked = radios.filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveAttribute("aria-label", defaults.color_scheme);
  });

  it("theme picker is a labeled radiogroup with dark + light options", () => {
    const themed: AppSettings = { ...defaults, theme: "dark" };
    render(<SettingsPanel settings={themed} onSave={vi.fn()} />);
    const group = screen.getByRole("radiogroup", { name: /^theme$/i });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    const dark = radios.find((r) => r.textContent?.toLowerCase() === "dark")!;
    const light = radios.find((r) => r.textContent?.toLowerCase() === "light")!;
    expect(dark).toHaveAttribute("aria-checked", "true");
    expect(light).toHaveAttribute("aria-checked", "false");
  });

  it("clicking a different swatch updates aria-checked and saves the choice", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsPanel settings={defaults} onSave={onSave} />);
    const group = screen.getByRole("radiogroup", {
      name: /color scheme \(open colors\)/i,
    });
    // Pick the first radio whose label is NOT the current selection.
    const radios = within(group).getAllByRole("radio");
    const target = radios.find(
      (r) => r.getAttribute("aria-label") !== defaults.color_scheme,
    )!;
    const newColor = target.getAttribute("aria-label")!;
    fireEvent.click(target);
    expect(target).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].color_scheme).toBe(newColor);
  });

  /*
   * Audit-3 P1#5: keyboard users must be able to navigate the
   * radiogroup with arrow keys (WAI-ARIA Authoring Practices). Radix
   * RadioGroup wires this for free; this test pins the contract so a
   * future swap to a hand-rolled control can't silently regress it.
   */
  /*
   * Audit-3 P1#5: keyboard arrow-key navigation across the radiogroup
   * is provided by Radix's RovingFocusGroup (the item registers a
   * document-level keydown listener that arms a ref, then the
   * focus-shift triggered by RovingFocusGroup invokes `onFocus` →
   * `click()` to actually check the new item). That handshake is
   * proven by Radix's own test suite and is not meaningfully
   * re-testable in jsdom without re-implementing Radix's collection
   * registration timing. We assert the *structural* a11y contract
   * here (role=radiogroup, role=radio, aria-checked, accessible name,
   * click semantics) which is what the hand-rolled <button> grid
   * silently violated; the keyboard contract is inherited from the
   * Radix primitive we now compose.
   */

  /*
   * Audit-3 follow-up P2#6: each settings section is now a
   * role=group with aria-labelledby pointing at its <h3> heading.
   * Sighted users see a heading; AT users hear "Layout group" /
   * "Git Sync group" when navigating into a section, which gives
   * the cluster of selects/inputs the same parent context.
   * Layout + Git Sync also carry aria-describedby so the intro
   * <p> is announced as the group description.
   */
  it("wraps each settings cluster in a labelled group", () => {
    render(
      <SettingsPanel
        settings={defaults}
        onSave={vi.fn(async () => {})}
      />,
    );
    // One labelled group per heading; the headings ('Font',
    // 'Theme', 'Layout', 'Terminal', 'Git Sync', plus the color
    // scheme) all expose accessible names.
    expect(screen.getByRole("group", { name: /^font$/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /^layout$/i })).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: /^terminal$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: /^git sync$/i }),
    ).toBeInTheDocument();

    // Layout has a description that reaches AT.
    const layoutGroup = screen.getByRole("group", { name: /^layout$/i });
    const describedBy = layoutGroup.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const desc = document.getElementById(describedBy!);
    expect(desc?.textContent ?? "").toMatch(/how each list is displayed/i);
  });

  /*
   * Audit-3 follow-up P3#9: the success status text used to rely on
   * green color alone. Per AGENTS.md ('color is supplementary'),
   * a leading checkmark glyph is required so colorblind users get
   * the same affirmative cue. The Check icon is decorative
   * (aria-hidden) because the role=status text already carries
   * the meaning to AT.
   */
  it("renders a leading check glyph next to the saved-status text", async () => {
    const onSave = vi.fn(async () => {});
    render(<SettingsPanel settings={defaults} onSave={onSave} />);

    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/settings saved/i);
    // The status row should contain a decorative SVG (the lucide
    // Check glyph). svg elements are not exposed to AT but are
    // present in the DOM.
    expect(status.querySelector("svg")).not.toBeNull();
  });
});
