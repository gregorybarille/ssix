import * as React from "react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Accessible radio group, built on Radix's RadioGroup primitive so it
 * gets `role="radiogroup"` on the root, `role="radio"` + `aria-checked`
 * on each item, full ArrowUp/Down/Left/Right + Home/End keyboard
 * navigation, focus management (only the checked item — or the first
 * item if none is checked — is in the tab order), and Space/Enter
 * activation for free.
 *
 * Use this instead of hand-rolled `<button>` grids whenever the user
 * is picking exactly one option from a small visible set (color
 * swatches, theme picker, storage-mode picker, etc.). Hand-rolled
 * grids of buttons are invisible to screen readers as a *group*: AT
 * announces them as N unrelated buttons rather than "color, radio
 * group, 8 options, blue selected, 1 of 8".
 *
 * The root accepts an `aria-label` or `aria-labelledby` (point it at
 * the section heading) so the group has an accessible name.
 *
 * NOTE — SSX deviation from canonical shadcn: `<RadioGroupItem>` is
 * intentionally a *presentationally-empty* wrapper. Pass your styled
 * visual (a swatch, a labelled chip, etc.) as children and use
 * `data-state=checked` for selected styling. Canonical shadcn renders
 * a built-in dot indicator inside the item; SSX does NOT, because the
 * surrounding visual carries the selected state. Existing call sites
 * in ConnectionForm / GenerateKeyDialog / SettingsPanel rely on this.
 */
function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("grid gap-2", className)}
      {...props}
    />
  );
}

function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        // Reset the default <button> chrome so callers can fully style
        // the item; preserve focus-visible ring so keyboard users see
        // which option is focused while navigating with arrows.
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-lg",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { RadioGroup, RadioGroupItem };
