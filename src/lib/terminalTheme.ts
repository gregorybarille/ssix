import type { ITheme } from "@xterm/xterm";
import type { AppSettings, Connection } from "@/types";

/**
 * xterm colour schemes. A connection can pick one (`color_scheme`); without
 * one, a terminal follows the app theme: Tokyo Night when dark, Tokyo Night
 * Day when light, so the two share hue families and a pane never clashes with
 * the surrounding chrome after a theme switch.
 */
const TOKYO_NIGHT: ITheme = {
  background: "#1a1b26",
  foreground: "#c0caf5",
  cursor: "#c0caf5",
  selectionBackground: "#33467c",
  black: "#15161e",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
  brightBlack: "#414868",
  brightRed: "#f7768e",
  brightGreen: "#9ece6a",
  brightYellow: "#e0af68",
  brightBlue: "#7aa2f7",
  brightMagenta: "#bb9af7",
  brightCyan: "#7dcfff",
  brightWhite: "#c0caf5",
};

const TOKYO_NIGHT_DAY: ITheme = {
  background: "#e1e2e7",
  foreground: "#3760bf",
  cursor: "#3760bf",
  selectionBackground: "#b7c1e3",
  black: "#b4b5b9",
  red: "#f52a65",
  green: "#587539",
  yellow: "#8c6c3e",
  blue: "#2e7de9",
  magenta: "#9854f1",
  cyan: "#007197",
  white: "#6172b0",
  brightBlack: "#a1a6c5",
  brightRed: "#f52a65",
  brightGreen: "#587539",
  brightYellow: "#8c6c3e",
  brightBlue: "#2e7de9",
  brightMagenta: "#9854f1",
  brightCyan: "#007197",
  brightWhite: "#3760bf",
};

const DRACULA: ITheme = {
  background: "#282a36",
  foreground: "#f8f8f2",
  cursor: "#f8f8f2",
  selectionBackground: "#44475a",
  black: "#21222c",
  red: "#ff5555",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  blue: "#bd93f9",
  magenta: "#ff79c6",
  cyan: "#8be9fd",
  white: "#f8f8f2",
  brightBlack: "#6272a4",
  brightRed: "#ff6e6e",
  brightGreen: "#69ff94",
  brightYellow: "#ffffa5",
  brightBlue: "#d6acff",
  brightMagenta: "#ff92df",
  brightCyan: "#a4ffff",
  brightWhite: "#ffffff",
};

const NORD: ITheme = {
  background: "#2e3440",
  foreground: "#d8dee9",
  cursor: "#d8dee9",
  selectionBackground: "#434c5e",
  black: "#3b4252",
  red: "#bf616a",
  green: "#a3be8c",
  yellow: "#ebcb8b",
  blue: "#81a1c1",
  magenta: "#b48ead",
  cyan: "#88c0d0",
  white: "#e5e9f0",
  brightBlack: "#4c566a",
  brightRed: "#bf616a",
  brightGreen: "#a3be8c",
  brightYellow: "#ebcb8b",
  brightBlue: "#81a1c1",
  brightMagenta: "#b48ead",
  brightCyan: "#8fbcbb",
  brightWhite: "#eceff4",
};

/** The ANSI colours Solarized dark and light share; its bright ones double as its greys. */
const SOLARIZED_ANSI: ITheme = {
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#586e75",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

const SOLARIZED_DARK: ITheme = {
  ...SOLARIZED_ANSI,
  background: "#002b36",
  foreground: "#839496",
  cursor: "#93a1a1",
  selectionBackground: "#073642",
};

/** The foreground is base01, not Solarized's base00, which falls short of 4.5:1 here. */
const SOLARIZED_LIGHT: ITheme = {
  ...SOLARIZED_ANSI,
  background: "#fdf6e3",
  foreground: "#586e75",
  cursor: "#586e75",
  selectionBackground: "#eee8d5",
};

const GRUVBOX_DARK: ITheme = {
  background: "#282828",
  foreground: "#ebdbb2",
  cursor: "#ebdbb2",
  selectionBackground: "#504945",
  black: "#282828",
  red: "#cc241d",
  green: "#98971a",
  yellow: "#d79921",
  blue: "#458588",
  magenta: "#b16286",
  cyan: "#689d6a",
  white: "#a89984",
  brightBlack: "#928374",
  brightRed: "#fb4934",
  brightGreen: "#b8bb26",
  brightYellow: "#fabd2f",
  brightBlue: "#83a598",
  brightMagenta: "#d3869b",
  brightCyan: "#8ec07c",
  brightWhite: "#ebdbb2",
};

const ONE_DARK: ITheme = {
  background: "#282c34",
  foreground: "#abb2bf",
  cursor: "#528bff",
  selectionBackground: "#3e4451",
  black: "#282c34",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#abb2bf",
  brightBlack: "#5c6370",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
};

export interface TerminalPalette {
  /** The stored `color_scheme`. */
  id: string;
  label: string;
  theme: ITheme;
}

/**
 * The schemes a connection can pick. A save checks `color_scheme` against the
 * same ids in `TERMINAL_COLOR_SCHEMES` (`src-tauri/src/commands/connections.rs`):
 * add a palette in both, or `src/test/terminalTheme.test.ts` fails.
 */
export const TERMINAL_PALETTES: readonly TerminalPalette[] = [
  { id: "tokyo-night", label: "Tokyo Night", theme: TOKYO_NIGHT },
  { id: "tokyo-night-day", label: "Tokyo Night Day", theme: TOKYO_NIGHT_DAY },
  { id: "dracula", label: "Dracula", theme: DRACULA },
  { id: "nord", label: "Nord", theme: NORD },
  { id: "solarized-dark", label: "Solarized Dark", theme: SOLARIZED_DARK },
  { id: "solarized-light", label: "Solarized Light", theme: SOLARIZED_LIGHT },
  { id: "gruvbox-dark", label: "Gruvbox Dark", theme: GRUVBOX_DARK },
  { id: "one-dark", label: "One Dark", theme: ONE_DARK },
];

export function isKnownColorScheme(id: string): boolean {
  return TERMINAL_PALETTES.some((palette) => palette.id === id);
}

/**
 * The colours of a terminal: its connection's scheme, otherwise the app's. A
 * stored scheme this build does not know falls back the same way, so it can
 * never stop a terminal from opening.
 */
export function terminalTheme(appTheme: string | undefined, colorScheme?: string | null): ITheme {
  const palette = TERMINAL_PALETTES.find((candidate) => candidate.id === colorScheme);
  if (palette) return palette.theme;
  return appTheme === "light" ? TOKYO_NIGHT_DAY : TOKYO_NIGHT;
}

const DEFAULT_FONT_FAMILY = "'JetBrains Mono', 'Fira Code', monospace";
const DEFAULT_FONT_SIZE = 14;
/** What `ConnectionAdvanced::validate` accepts in `commands/connections.rs`. */
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;

function usableFontSize(size: number | null | undefined): number | undefined {
  return typeof size === "number" && size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE
    ? size
    : undefined;
}

function xtermFontFamily(family: string | null | undefined): string | undefined {
  const safe = family?.replace(/['"\\]/g, "").trim();
  return safe ? `'${safe}', monospace` : undefined;
}

export interface TerminalAppearance {
  fontFamily: string;
  fontSize: number;
  theme: ITheme;
}

/**
 * How a terminal looks: what its connection overrides, then the app's
 * settings. A stored value a terminal could not use is passed over.
 */
export function terminalAppearance(
  connection: Connection | undefined,
  settings: AppSettings | undefined,
): TerminalAppearance {
  return {
    fontFamily:
      xtermFontFamily(connection?.font_family) ??
      xtermFontFamily(settings?.font_family) ??
      DEFAULT_FONT_FAMILY,
    fontSize:
      usableFontSize(connection?.font_size) ??
      usableFontSize(settings?.font_size) ??
      DEFAULT_FONT_SIZE,
    theme: terminalTheme(settings?.theme, connection?.color_scheme),
  };
}

function isLight(hexColor: string): boolean {
  const channel = (start: number) => Number.parseInt(hexColor.slice(start, start + 2), 16);
  // ITU-R BT.601 luma, enough to tell a light background from a dark one.
  return 0.299 * channel(1) + 0.587 * channel(3) + 0.114 * channel(5) > 127.5;
}

/**
 * The search highlight for a theme. Text keeps its own colour under a
 * highlight, so the backgrounds stay dark enough for a dim foreground such as
 * Solarized's, or light enough on a light scheme, and the border is what makes
 * a match stand out. xterm takes `#RRGGBB` only.
 */
export function searchHighlight(theme: ITheme) {
  const light = isLight(theme.background ?? "#000000");
  return {
    matchBackground: light ? "#f3e6a0" : "#1f4068",
    matchBorder: light ? "#8a6800" : "#7aa2f7",
    activeMatchBackground: light ? "#f2cc60" : "#5c3d00",
    activeMatchBorder: light ? "#b34700" : "#ff9e3b",
    matchOverviewRuler: "#e0af68",
    activeMatchColorOverviewRuler: "#f7768e",
  };
}
