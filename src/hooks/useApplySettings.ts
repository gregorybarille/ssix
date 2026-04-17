import { useEffect } from "react";
import { AppSettings } from "@/types";

// HSL values for each Open Color scheme (primary + foreground on that primary)
const COLOR_SCHEME_HSL: Record<string, { primary: string; ring: string }> = {
  blue:   { primary: "210 83% 57%",  ring: "210 83% 57%" },
  green:  { primary: "128 55% 56%",  ring: "128 55% 56%" },
  red:    { primary: "0 100% 71%",   ring: "0 100% 71%" },
  yellow: { primary: "45 97% 55%",   ring: "45 97% 55%" },
  grape:  { primary: "290 72% 63%",  ring: "290 72% 63%" },
  cyan:   { primary: "187 65% 47%",  ring: "187 65% 47%" },
  pink:   { primary: "337 80% 67%",  ring: "337 80% 67%" },
  orange: { primary: "28 100% 58%",  ring: "28 100% 58%" },
  teal:   { primary: "162 62% 47%",  ring: "162 62% 47%" },
  violet: { primary: "263 88% 63%",  ring: "263 88% 63%" },
  indigo: { primary: "226 93% 67%",  ring: "226 93% 67%" },
  lime:   { primary: "80 68% 51%",   ring: "80 68% 51%" },
};

export function useApplySettings(settings: AppSettings) {
  useEffect(() => {
    const root = document.documentElement;

    // Theme: toggle .dark / .light on <html>
    if (settings.theme === "light") {
      root.classList.remove("dark");
      root.classList.add("light");
    } else {
      root.classList.remove("light");
      root.classList.add("dark");
    }

    // Color scheme: update --primary and --ring CSS variables
    const scheme = COLOR_SCHEME_HSL[settings.color_scheme];
    if (scheme) {
      root.style.setProperty("--primary", scheme.primary);
      // Always use white text on the colored primary buttons
      root.style.setProperty("--primary-foreground", "0 0% 100%");
      root.style.setProperty("--ring", scheme.ring);
    }

    // Font family and size applied to body
    document.body.style.fontFamily = `${settings.font_family}, monospace`;
    document.body.style.fontSize = `${settings.font_size}px`;
  }, [settings]);
}
