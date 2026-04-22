import { OPEN_COLORS, OpenColor } from "@/types";

/**
 * Open Color hex values used for the color scheme picker, the per-connection
 * color accent, and any other place that needs to render an Open Color swatch.
 */
export const COLOR_VALUES: Record<OpenColor, string> = {
  blue: "#339af0",
  green: "#51cf66",
  red: "#ff6b6b",
  yellow: "#fcc419",
  grape: "#cc5de8",
  cyan: "#22b8cf",
  pink: "#f06595",
  orange: "#ff922b",
  teal: "#20c997",
  violet: "#7950f2",
  indigo: "#5c7cfa",
  lime: "#94d82d",
};

export function getColorHex(name?: string | null): string | undefined {
  if (!name) return undefined;
  return (COLOR_VALUES as Record<string, string>)[name];
}

export { OPEN_COLORS };
