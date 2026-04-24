import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
