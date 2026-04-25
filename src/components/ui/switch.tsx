import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

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
 * Sizing follows shadcn 4.5 new-york-v4: `default` is a compact
 * 1.15rem-tall track, `sm` is even smaller. Both line up with `<Input>`
 * and `<Button>` in form rows.
 */
function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default";
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch inline-flex shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-[1.15rem] data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-background ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0 dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-foreground",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
