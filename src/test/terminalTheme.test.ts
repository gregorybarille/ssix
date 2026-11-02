import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isKnownColorScheme,
  searchHighlight,
  TERMINAL_PALETTES,
  terminalAppearance,
  terminalTheme,
} from "@/lib/terminalTheme";
import type { AppSettings, Connection } from "@/types";

const settings = { theme: "dark", font_family: "Fira Code", font_size: 14 } as AppSettings;
const connection = (fields: Partial<Connection>) => ({ id: "c1", ...fields }) as Connection;
const TOKYO_NIGHT = "#1a1b26";
const TOKYO_NIGHT_DAY = "#e1e2e7";

function luminance(hex: string): number {
  const channel = (start: number) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + 0.05) / (low + 0.05);
}

describe("terminalTheme", () => {
  it("follows the app theme with no scheme", () => {
    expect(terminalTheme("dark").background).toBe(TOKYO_NIGHT);
    expect(terminalTheme("light").background).toBe(TOKYO_NIGHT_DAY);
    expect(terminalTheme(undefined).background).toBe(TOKYO_NIGHT);
    expect(terminalTheme("light", null).background).toBe(TOKYO_NIGHT_DAY);
  });

  it("takes the connection's scheme over the app theme", () => {
    expect(terminalTheme("light", "dracula").background).toBe("#282a36");
    expect(terminalTheme("dark", "solarized-light").background).toBe("#fdf6e3");
  });

  it("falls back to the app's scheme for one it does not know", () => {
    expect(terminalTheme("dark", "retired-palette").background).toBe(TOKYO_NIGHT);
    expect(terminalTheme("light", "retired-palette").background).toBe(TOKYO_NIGHT_DAY);
    expect(isKnownColorScheme("retired-palette")).toBe(false);
    expect(isKnownColorScheme("dracula")).toBe(true);
  });
});

describe("terminalAppearance", () => {
  it("takes the connection first, then settings", () => {
    const looks = terminalAppearance(
      connection({ font_family: "Hack", font_size: 18, color_scheme: "nord" }),
      settings,
    );
    expect(looks.fontFamily).toBe("'Hack', monospace");
    expect(looks.fontSize).toBe(18);
    expect(looks.theme.background).toBe("#2e3440");
  });

  it("uses settings for whatever the connection leaves unset", () => {
    const looks = terminalAppearance(connection({ font_size: 18 }), settings);
    expect(looks.fontFamily).toBe("'Fira Code', monospace");
    expect(looks.fontSize).toBe(18);
    expect(looks.theme.background).toBe(TOKYO_NIGHT);
  });

  it("has defaults with neither", () => {
    const looks = terminalAppearance(undefined, undefined);
    expect(looks.fontFamily).toContain("monospace");
    expect(looks.fontSize).toBe(14);
    expect(looks.theme.background).toBe(TOKYO_NIGHT);
  });

  it("passes over stored values a terminal could not use", () => {
    const looks = terminalAppearance(
      connection({ font_size: 4000, font_family: "   ", color_scheme: "retired-palette" }),
      settings,
    );
    expect(looks.fontSize).toBe(14);
    expect(looks.fontFamily).toBe("'Fira Code', monospace");
    expect(looks.theme.background).toBe(TOKYO_NIGHT);
  });

  it("keeps quotes in a stored font out of the font string", () => {
    const looks = terminalAppearance(connection({ font_family: `Ha'ck"\\` }), settings);
    expect(looks.fontFamily).toBe("'Hack', monospace");
  });
});

describe("the palettes", () => {
  const ANSI = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
  ] as const;

  it.each(TERMINAL_PALETTES.map((palette) => [palette.id, palette] as const))(
    "%s is complete, in the #RRGGBB form xterm needs",
    (_id, { theme }) => {
      for (const field of ["background", "foreground", "cursor", "selectionBackground", ...ANSI] as const) {
        expect(theme[field], field).toMatch(/^#[0-9a-f]{6}$/);
      }
    },
  );

  it.each(TERMINAL_PALETTES.map((palette) => [palette.id, palette] as const))(
    "%s has readable text, also when selected",
    (_id, { theme }) => {
      const { background, foreground, selectionBackground } = theme as Record<string, string>;
      expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(foreground, selectionBackground)).toBeGreaterThanOrEqual(3);
    },
  );

  it("has unique ids and labels", () => {
    expect(new Set(TERMINAL_PALETTES.map((p) => p.id)).size).toBe(TERMINAL_PALETTES.length);
    expect(new Set(TERMINAL_PALETTES.map((p) => p.label)).size).toBe(TERMINAL_PALETTES.length);
  });

  /** A save checks the id on the other side of the IPC boundary. */
  it("are the schemes the backend accepts", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src-tauri/src/commands/connections.rs"),
      "utf8",
    );
    const list = /const TERMINAL_COLOR_SCHEMES: &\[&str\] = &\[([^\]]*)\]/.exec(source);
    expect(list).not.toBeNull();
    const backend = [...(list?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(backend).toEqual(TERMINAL_PALETTES.map((palette) => palette.id));
  });
});

describe("searchHighlight", () => {
  it.each(TERMINAL_PALETTES.map((palette) => [palette.id, palette] as const))(
    "leaves %s's text readable under a match, in the #RRGGBB form the addon needs",
    (_id, { theme }) => {
      const highlight = searchHighlight(theme);
      const foreground = theme.foreground as string;
      expect(contrast(foreground, highlight.matchBackground)).toBeGreaterThanOrEqual(3);
      expect(contrast(foreground, highlight.activeMatchBackground)).toBeGreaterThanOrEqual(3);
      for (const color of Object.values(highlight)) {
        expect(color).toMatch(/^#[0-9a-f]{6}$/);
      }
    },
  );

  it.each(TERMINAL_PALETTES.map((palette) => [palette.id, palette] as const))(
    "makes a match stand out on %s, by its border, and the active one from the others",
    (_id, { theme }) => {
      const highlight = searchHighlight(theme);
      const background = theme.background as string;
      expect(contrast(highlight.matchBorder, background)).toBeGreaterThanOrEqual(3);
      expect(contrast(highlight.activeMatchBorder, background)).toBeGreaterThanOrEqual(3);
      expect(highlight.activeMatchBackground).not.toBe(highlight.matchBackground);
      expect(highlight.activeMatchBorder).not.toBe(highlight.matchBorder);
    },
  );
});
