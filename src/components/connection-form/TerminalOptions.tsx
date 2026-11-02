import { isKnownColorScheme, TERMINAL_PALETTES } from "@/lib/terminalTheme";
import { FONT_FAMILIES, FONT_SIZES } from "@/types";
import type { ConnectionFormSectionProps } from "./advanced";
import { ChoiceSelect, type Choice } from "./ChoiceSelect";

/** The choice that clears an override. */
const DEFAULT_CHOICE = "default";

/** A saved value the list does not offer stays visible, so the form never hides what is stored. */
function withSaved(choices: Choice[], saved: string, label: string): Choice[] {
  return saved === DEFAULT_CHOICE || choices.some((choice) => choice.value === saved)
    ? choices
    : [...choices, { value: saved, label }];
}

function parseFontSize(choice: string): number | undefined {
  return choice === DEFAULT_CHOICE ? undefined : Number(choice);
}

function overrideText(choice: string): string | undefined {
  return choice === DEFAULT_CHOICE ? undefined : choice;
}

/**
 * Font and colours of one connection's terminal. Anything left unset follows
 * Settings and the app theme; see `docs/terminal-ux.md`.
 *
 * A saved scheme that this build no longer offers still opens a terminal, in
 * the app's colours, but a save refuses it (`ConnectionAdvanced::validate`), so
 * it says here why and which field to change.
 */
export function TerminalOptions({ advanced, onChange }: ConnectionFormSectionProps) {
  const fontFamily = advanced.font_family ?? DEFAULT_CHOICE;
  const fontSize = advanced.font_size == null ? DEFAULT_CHOICE : String(advanced.font_size);
  const colorScheme = advanced.color_scheme ?? DEFAULT_CHOICE;
  const unknownScheme =
    colorScheme !== DEFAULT_CHOICE && !isKnownColorScheme(colorScheme) ? colorScheme : null;

  return (
    <div className="space-y-3" role="group" aria-labelledby="terminal-options-heading">
      <div className="space-y-1">
        <h3 id="terminal-options-heading" className="text-sm font-medium">
          Terminal
        </h3>
        <p className="text-xs text-muted-foreground">
          For shell sessions. Saving applies these to this connection&apos;s open terminals at once.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <ChoiceSelect
          id="terminal_font_family"
          label="Font"
          testId="connection-form-font-family"
          value={fontFamily}
          choices={withSaved(
            [
              { value: DEFAULT_CHOICE, label: "Use app setting" },
              ...FONT_FAMILIES.map((family) => ({ value: family, label: family })),
            ],
            fontFamily,
            fontFamily,
          )}
          onChange={(choice) => onChange({ font_family: overrideText(choice) })}
        />
        <ChoiceSelect
          id="terminal_font_size"
          label="Font size"
          testId="connection-form-font-size"
          value={fontSize}
          choices={withSaved(
            [
              { value: DEFAULT_CHOICE, label: "Use app setting" },
              ...FONT_SIZES.map((size) => ({ value: String(size), label: `${size}px` })),
            ],
            fontSize,
            `${fontSize}px`,
          )}
          onChange={(choice) => onChange({ font_size: parseFontSize(choice) })}
        />
      </div>
      <ChoiceSelect
        id="terminal_color_scheme"
        label="Color scheme"
        testId="connection-form-color-scheme"
        value={colorScheme}
        choices={withSaved(
          [
            { value: DEFAULT_CHOICE, label: "Follow the app theme" },
            ...TERMINAL_PALETTES.map(({ id, label }) => ({ value: id, label })),
          ],
          colorScheme,
          `${colorScheme} (no longer available)`,
        )}
        error={
          unknownScheme
            ? `The color scheme "${unknownScheme}" is no longer available, so this connection cannot be saved with it. Its terminals use the app's colors. Pick another scheme.`
            : undefined
        }
        onChange={(choice) => onChange({ color_scheme: overrideText(choice) })}
      />
    </div>
  );
}
