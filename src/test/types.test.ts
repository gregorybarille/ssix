import { describe, it, expect } from "vitest";
import { OPEN_COLORS, FONT_FAMILIES, FONT_SIZES } from "@/types";

describe("Types and constants", () => {
  it("exports OPEN_COLORS array", () => {
    expect(OPEN_COLORS).toContain("blue");
    expect(OPEN_COLORS).toContain("green");
    expect(OPEN_COLORS.length).toBeGreaterThan(0);
  });

  it("exports FONT_FAMILIES array", () => {
    expect(FONT_FAMILIES).toContain("JetBrains Mono");
    expect(FONT_FAMILIES.length).toBeGreaterThan(0);
  });

  it("exports FONT_SIZES array", () => {
    expect(FONT_SIZES).toContain(14);
    expect(FONT_SIZES.length).toBeGreaterThan(0);
  });
});
