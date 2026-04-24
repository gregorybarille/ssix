import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
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
const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer h-4 w-4 shrink-0 rounded-sm border border-primary",
      "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      className={cn("flex items-center justify-center text-current")}
    >
      <Check className="h-3 w-3" aria-hidden="true" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
