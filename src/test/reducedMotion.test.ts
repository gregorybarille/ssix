import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/*
 * Audit-3 #3: prefers-reduced-motion guard.
 *
 * jsdom can't actually evaluate `@media (prefers-reduced-motion:
 * reduce)` rules against a real OS preference, so testing the live
 * computed style is out of reach. Instead we assert the structural
 * contract on globals.css: a single global block that neutralises
 * animation/transition durations to ~0 (using 0.01ms so that
 * transitionend / animationend handlers — Radix included — still
 * fire), and that nukes scroll-behavior smooth scrolling.
 *
 * If you intentionally remove or reshape this rule, update both this
 * test and `docs/features.md` (Reduced motion section) in the same
 * change.
 */

const css = readFileSync(
  resolve(__dirname, "../styles/globals.css"),
  "utf8",
);

describe("globals.css — prefers-reduced-motion", () => {
  it("includes a prefers-reduced-motion: reduce media query", () => {
    expect(css).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
  });

  it("neutralises animation-duration to ~0 with !important", () => {
    expect(css).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
  });

  it("neutralises transition-duration to ~0 with !important", () => {
    expect(css).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });

  it("forces non-iterating animations (iteration-count: 1)", () => {
    expect(css).toMatch(/animation-iteration-count:\s*1\s*!important/);
  });

  it("disables smooth scroll behavior", () => {
    expect(css).toMatch(/scroll-behavior:\s*auto\s*!important/);
  });

  it("targets all elements + pseudo-elements", () => {
    // Order-insensitive: the rule should at least cover *, *::before,
    // *::after as a single selector list.
    expect(css).toMatch(/\*,\s*\*::before,\s*\*::after/);
  });
});
