import type { ConnectionFormSectionProps } from "./advanced";

/**
 * Terminal options of the connection form (roadmap: terminal-ux). Owned by
 * the terminal-ux stream, which adds the per-connection font family, font
 * size and colour scheme overrides here (`advanced.font_family`,
 * `advanced.font_size`, `advanced.color_scheme`; unset means "use the
 * setting"). Renders nothing until then.
 */
export function TerminalOptions(_props: ConnectionFormSectionProps) {
  return null;
}
