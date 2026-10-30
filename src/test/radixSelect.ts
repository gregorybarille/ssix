import { fireEvent } from "@testing-library/react";

/**
 * Pick `value` in the Radix Select behind `trigger`. Inside a form Radix
 * renders a hidden native `<select>` next to the trigger (for autofill) and
 * follows its `change` events, which jsdom can drive without the pointer
 * capture APIs the popup needs.
 */
export function chooseSelectValue(trigger: HTMLElement, value: string): void {
  const native = trigger.parentElement?.querySelector("select");
  if (!native) throw new Error("No native select next to the Radix trigger");
  fireEvent.change(native, { target: { value } });
}
