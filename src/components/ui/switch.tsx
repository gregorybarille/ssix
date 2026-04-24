import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

/**
 * Accessible on/off toggle, built on Radix's Switch primitive so it gets
 * `role="switch"`, `aria-checked`, Space/Enter keyboard activation, and
 * focus-visible behavior for free.
 *
 * Use this instead of a hand-rolled `<input type="checkbox">` for any
 * boolean preference where the user is choosing "on" vs "off" (rather
 * than ticking an item in a list — that's a checkbox). Pair with a
 * `<Label htmlFor>` for an accessible name; clicks on the label will
 * toggle the switch.
 *
 * Sizing matches the rest of the form primitives (h-6 / w-11 thumb-sized
 * track, 20px thumb, 4px translate range) so it lines up vertically with
 * `<Input>` and `<Button>` in form rows.
 */
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent",
      "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform",
        "data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
