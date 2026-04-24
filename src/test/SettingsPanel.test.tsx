import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsPanel } from "@/components/SettingsPanel";
import type { AppSettings } from "@/types";

const defaults: AppSettings = {
  font_size: 14,
  font_family: "monospace",
  color_scheme: "default",
  theme: "system",
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
});
