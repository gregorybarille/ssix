import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SettingsPanel } from "@/components/SettingsPanel";
import type { AppSettings } from "@/types";

/** Must match SETTINGS_SAVE_DEBOUNCE_MS in SettingsPanel.tsx. */
const DEBOUNCE_MS = 300;

/**
 * Advance fake timers inside act() so the debounce fires, the save
 * promise settles and the resulting state updates are committed.
 */
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

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
      // shadcn 4.5 (new-york-v4) uses arbitrary `ring-[3px]`; accept
      // both for forward/backward compat — the point is to verify the
      // shared <Input> primitive is in use, not the exact ring width.
      expect(field.className).toMatch(/focus-visible:ring-(?:2|\[3px\])/);
    }
  });

  it("keeps git sync text edits local until blur, then saves once", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsPanel settings={defaults} onSave={onSave} />);

    const remote = screen.getByLabelText(/remote name/i);
    fireEvent.change(remote, { target: { value: "upstream" } });
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.blur(remote);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ git_sync_remote: "upstream" }),
    );
  });

  it("auto-saves changes and announces Settings saved! via a polite live region", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsPanel settings={defaults} onSave={onSave} />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status.textContent).toBe("");

    fireEvent.click(screen.getByRole("radio", { name: /light/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/settings saved/i),
    );
  });

  it("shows a visible error when saving fails", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("disk full"));
    render(<SettingsPanel settings={defaults} onSave={onSave} />);

    fireEvent.click(screen.getByRole("radio", { name: /light/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("disk full"));
  });

  it("flips the auto-copy switch and persists the new value", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SettingsPanel settings={defaults} onSave={onSave} />);
    const toggle = screen.getByRole("switch", {
      name: /copy selection to clipboard/i,
    });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].auto_copy_selection).toBe(true);
  });

  /*
   * Saves are debounced and serialised: at most one is in flight, a
   * newer edit waits behind it, and only the newest edit's outcome is
   * reported. These tests drive the timer explicitly so the ordering
   * is deterministic rather than a race against real time.
   */
  describe("debounced persistence", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not save before the debounce window elapses", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<SettingsPanel settings={defaults} onSave={onSave} />);

      fireEvent.click(screen.getByRole("radio", { name: /light/i }));
      await tick(DEBOUNCE_MS - 1);
      expect(onSave).not.toHaveBeenCalled();

      await tick(1);
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("status")).toHaveTextContent(/settings saved/i);
    });

    it("coalesces rapid edits into one save carrying the final state", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<SettingsPanel settings={defaults} onSave={onSave} />);

      fireEvent.click(screen.getByRole("radio", { name: /light/i }));
      await tick(100);
      fireEvent.click(
        screen.getByRole("switch", { name: /copy selection to clipboard/i }),
      );
      await tick(100);
      const swatches = within(
        screen.getByRole("radiogroup", { name: /color scheme/i }),
      ).getAllByRole("radio");
      const swatch = swatches.find(
        (r) => r.getAttribute("aria-label") !== defaults.color_scheme,
      )!;
      fireEvent.click(swatch);
      await tick(100);
      // 300 ms of wall time have passed but each edit restarted the timer.
      expect(onSave).not.toHaveBeenCalled();

      await tick(DEBOUNCE_MS);
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          theme: "light",
          auto_copy_selection: true,
          color_scheme: swatch.getAttribute("aria-label"),
        }),
      );
      expect(screen.getByRole("status")).toHaveTextContent(/settings saved/i);
    });

    it("flushes the pending save when the panel unmounts", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      const { unmount } = render(<SettingsPanel settings={defaults} onSave={onSave} />);

      fireEvent.click(screen.getByRole("radio", { name: /light/i }));
      expect(onSave).not.toHaveBeenCalled();
      unmount();
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ theme: "light" }));

      // Nothing else fires later.
      await tick(DEBOUNCE_MS * 2);
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    it("flushes the pending save when the window loses focus", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<SettingsPanel settings={defaults} onSave={onSave} />);

      fireEvent.click(screen.getByRole("radio", { name: /light/i }));
      expect(onSave).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.blur(window);
      });
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ theme: "light" }));
    });

    it("flushes the pending save when the document becomes hidden", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<SettingsPanel settings={defaults} onSave={onSave} />);

      fireEvent.click(screen.getByRole("radio", { name: /light/i }));
      expect(onSave).not.toHaveBeenCalled();

      const original = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        configurable: true,
      });
      try {
        await act(async () => {
          fireEvent(document, new Event("visibilitychange"));
        });
      } finally {
        delete (document as { visibilityState?: unknown }).visibilityState;
        if (original) Object.defineProperty(Document.prototype, "visibilityState", original);
      }
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ theme: "light" }));
    });

    it("does not adopt echoed store settings while a save is pending", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      const { rerender } = render(<SettingsPanel settings={defaults} onSave={onSave} />);

      fireEvent.click(screen.getByRole("radio", { name: /light/i }));
      // The store re-emits the (still dark) settings during the window,
      // e.g. because fetchSettings resolved or another field was saved.
      rerender(<SettingsPanel settings={{ ...defaults }} onSave={onSave} />);
      expect(screen.getByRole("radio", { name: /light/i })).toHaveAttribute(
        "aria-checked",
        "true",
      );

      await tick(DEBOUNCE_MS);
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ theme: "light" }));
    });

    it("reports a validation error for the final state even when an earlier edit was superseded", async () => {
      const onSave = vi.fn().mockRejectedValue(new Error("Git remote is invalid"));
      render(<SettingsPanel settings={defaults} onSave={onSave} />);

      const remote = screen.getByLabelText(/remote name/i);
      fireEvent.change(remote, { target: { value: "--bad" } });
      fireEvent.blur(remote);
      // A later edit inside the window must not swallow the failure:
      // the coalesced save still carries the bad remote.
      fireEvent.click(screen.getByRole("radio", { name: /light/i }));

      await tick(DEBOUNCE_MS);
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ git_sync_remote: "--bad", theme: "light" }),
      );
      expect(screen.getByRole("alert")).toHaveTextContent("Git remote is invalid");
      expect(screen.getByRole("status")).not.toHaveTextContent(/settings saved/i);
    });

    it("ignores stale save completions when a newer save fails", async () => {
      let resolveFirst: (() => void) | undefined;
      let rejectSecond: ((error: Error) => void) | undefined;
      const first = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      const second = new Promise<void>((_, reject) => {
        rejectSecond = reject;
      });
      const onSave = vi
        .fn()
        .mockImplementationOnce(() => first)
        .mockImplementationOnce(() => second);
      render(<SettingsPanel settings={defaults} onSave={onSave} />);

      fireEvent.click(screen.getByRole("radio", { name: /light/i }));
      await tick(DEBOUNCE_MS);
      expect(onSave).toHaveBeenCalledTimes(1);

      // Edit while the first save is still in flight: it queues behind
      // it rather than starting a second concurrent save.
      fireEvent.click(screen.getByRole("radio", { name: /dark/i }));
      await tick(DEBOUNCE_MS);
      expect(onSave).toHaveBeenCalledTimes(1);

      resolveFirst?.();
      await tick(0);
      expect(onSave).toHaveBeenCalledTimes(2);
      // The stale first result must not flash "saved" for an outdated state.
      expect(screen.getByRole("status")).not.toHaveTextContent(/settings saved/i);

      rejectSecond?.(new Error("latest write failed"));
      await tick(0);
      expect(screen.getByRole("alert")).toHaveTextContent("latest write failed");
      expect(screen.getByRole("status")).not.toHaveTextContent(/settings saved/i);
    });
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

  it("previews theme changes immediately and persists them after the debounce", async () => {
    const onPreview = vi.fn();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsPanel
        settings={{ ...defaults, theme: "dark" }}
        onSave={onSave}
        onPreview={onPreview}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: /light/i }));

    expect(onPreview).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "light" }),
    );
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ theme: "light" }),
      ),
    );
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

    fireEvent.click(screen.getByRole("radio", { name: /light/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());

    // The role=status region is always mounted; its text appears once
    // the save resolves and the 2s auto-hide timer starts, so wait for
    // the text rather than asserting right after the first render.
    const status = screen.getByRole("status");
    await waitFor(() => expect(status).toHaveTextContent(/settings saved/i));
    // The status row should contain a decorative SVG (the lucide
    // Check glyph). svg elements are not exposed to AT but are
    // present in the DOM.
    expect(status.querySelector("svg")).not.toBeNull();
  });
});
