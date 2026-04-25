import * as React from "react";
import { CheckIcon } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Accessible checkbox, built on Radix's Checkbox primitive so it gets
 * `role="checkbox"`, `aria-checked` (with tri-state support for
 * `indeterminate`), Space activation, and focus-visible behavior for
 * free.
 *
 * Use this for *list-style* booleans where the user is ticking a
 * property of an action or item ("transfer recursively", "include
 * hidden files"). For app-wide *preference* toggles (settings page),
 * prefer `<Switch>` — the visual + semantic distinction is what AT
 * users hear ("checked" vs "on/off") and what mouse users expect.
 *
 * Pair with a `<Label htmlFor>` (or wrap the checkbox + text in a
 * `<label>`) for an accessible name; clicks on the label will toggle
 * the checkbox.
 *
 * Sizing matches `<Input>` line-height (16px) so the box lines up
 * with the label baseline.
 */
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer size-4 shrink-0 rounded-[4px] border border-input shadow-xs transition-shadow outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:bg-input/30 dark:aria-invalid:ring-destructive/40 dark:data-[state=checked]:bg-primary",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        {/* Audit: decorative icon — the Indicator wrapper conveys checked state to AT. */}
        <CheckIcon className="size-3.5" aria-hidden="true" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
