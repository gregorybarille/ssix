import { describe, it, expect } from "vitest";

/**
 * Lightweight WCAG 2.1 contrast computation. We parse the HSL strings
 * defined as CSS custom properties (e.g. `215 16% 38%`) into sRGB and
 * apply the standard relative-luminance formula.
 *
 * This guards `--muted-foreground-soft` (and a few related tokens)
 * against future regressions: any change to the HSL values must keep
 * the body-text contrast ratio at or above WCAG AA (4.5:1) on both the
 * light and dark surfaces it ships on.
 */

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: [number, number, number], b: [number, number, number]) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseHsl(triplet: string): [number, number, number] {
  // "215 16% 38%" → [215, 16, 38]
  const parts = triplet
    .replace(/%/g, "")
    .trim()
    .split(/\s+/)
    .map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Bad HSL triplet: ${triplet}`);
  }
  return [parts[0], parts[1], parts[2]];
}

function rgbForToken(triplet: string) {
  const [h, s, l] = parseHsl(triplet);
  return hslToRgb(h, s, l);
}

// These mirror the values in src/styles/globals.css. If the CSS file
// changes, update these constants too — and re-check the assertions.
const TOKENS = {
  light: {
    background: "0 0% 100%",
    foreground: "222.2 84% 4.9%",
    mutedForeground: "215.4 16.3% 46.9%",
    mutedForegroundSoft: "215 16% 38%",
  },
  dark: {
    background: "222.2 84% 4.9%",
    foreground: "210 40% 98%",
    mutedForeground: "215 20.2% 65.1%",
    mutedForegroundSoft: "215 20% 55%",
  },
} as const;

describe("Theme color contrast", () => {
  it("light: muted-foreground-soft on background meets WCAG AA (>= 4.5:1)", () => {
    const ratio = contrast(
      rgbForToken(TOKENS.light.mutedForegroundSoft),
      rgbForToken(TOKENS.light.background),
    );
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("dark: muted-foreground-soft on background meets WCAG AA (>= 4.5:1)", () => {
    const ratio = contrast(
      rgbForToken(TOKENS.dark.mutedForegroundSoft),
      rgbForToken(TOKENS.dark.background),
    );
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("light: muted-foreground on background meets WCAG AA (>= 4.5:1)", () => {
    const ratio = contrast(
      rgbForToken(TOKENS.light.mutedForeground),
      rgbForToken(TOKENS.light.background),
    );
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("dark: muted-foreground on background meets WCAG AA (>= 4.5:1)", () => {
    const ratio = contrast(
      rgbForToken(TOKENS.dark.mutedForeground),
      rgbForToken(TOKENS.dark.background),
    );
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("regression: the old `text-muted-foreground/70` blend FAILS AA on light theme (so we removed it)", () => {
    // muted-foreground at 70% opacity on white blends to roughly:
    //   r' = 0.3*255 + 0.7*r
    const [r, g, b] = rgbForToken(TOKENS.light.mutedForeground);
    const blended: [number, number, number] = [
      0.3 * 255 + 0.7 * r,
      0.3 * 255 + 0.7 * g,
      0.3 * 255 + 0.7 * b,
    ];
    const ratio = contrast(blended, rgbForToken(TOKENS.light.background));
    // Captures the original failure (~2.7:1) so we don't accidentally
    // re-introduce the pattern.
    expect(ratio).toBeLessThan(4.5);
  });
});
