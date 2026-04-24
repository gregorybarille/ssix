import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { GenerateKeyDialog } from "@/components/GenerateKeyDialog";
import { invoke } from "@/lib/tauri";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

describe("GenerateKeyDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /*
   * Audit-3 P2#9: storage picker was three hand-rolled
   * <input type=radio> with `accent-primary` — different glyph per
   * OS, no theme tokens, no consistent focus ring. Now goes through
   * the shared <RadioGroup> primitive (Radix-backed). Pin the
   * structural a11y contract:
   *   - role=radiogroup with an accessible name (aria-labelledby)
   *   - exactly three role=radio children
   *   - aria-checked toggling on click
   *   - no native <input type="radio"> remain visible to AT
   */
  it("storage picker is a proper radiogroup with three radio options", () => {
    render(
      <GenerateKeyDialog
        open
        onOpenChange={vi.fn()}
        onGenerated={vi.fn()}
      />,
    );
    const group = screen.getByRole("radiogroup");
    expect(group).toHaveAccessibleName(/storage/i);

    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(3);

    // Default starts checked.
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(radios[1]).toHaveAttribute("aria-checked", "false");
    expect(radios[2]).toHaveAttribute("aria-checked", "false");

    // Click custom_path.
    fireEvent.click(radios[1]);
    expect(radios[0]).toHaveAttribute("aria-checked", "false");
    expect(radios[1]).toHaveAttribute("aria-checked", "true");
  });

  it("does not expose any visible native radio inputs", () => {
    render(
      <GenerateKeyDialog
        open
        onOpenChange={vi.fn()}
        onGenerated={vi.fn()}
      />,
    );
    // Radix may render a hidden form-shim input; if so it must be
    // aria-hidden so AT only sees the role=radio button.
    document.querySelectorAll('input[type="radio"]').forEach((n) => {
      expect(n).toHaveAttribute("aria-hidden", "true");
    });
    // The actual a11y radios are buttons, not inputs.
    const radios = screen.getAllByRole("radio");
    radios.forEach((r) => expect(r.tagName).toBe("BUTTON"));
  });

  /*
   * Audit-3 P2#10: error message was a plain <p> — silent to
   * screen readers. Submit-blocking errors must be role=alert +
   * aria-live=assertive so AT announces them when they appear.
   */
  it("surfaces submit errors via role=alert + aria-live=assertive", async () => {
    vi.mocked(invoke).mockRejectedValue("backend exploded");
    render(
      <GenerateKeyDialog
        open
        onOpenChange={vi.fn()}
        onGenerated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toHaveAttribute("aria-live", "assertive");
      expect(alert.textContent).toMatch(/backend exploded/);
    });
  });

  it("blocks custom_path submit with an empty path and announces the error", async () => {
    render(
      <GenerateKeyDialog
        open
        onOpenChange={vi.fn()}
        onGenerated={vi.fn()}
      />,
    );
    // Switch to custom_path.
    const radios = within(screen.getByRole("radiogroup")).getAllByRole("radio");
    fireEvent.click(radios[1]);
    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toHaveAttribute("aria-live", "assertive");
      expect(alert.textContent).toMatch(/custom path is required/i);
    });
    // invoke must NOT have been called — the client-side guard fired.
    expect(invoke).not.toHaveBeenCalled();
  });
});
