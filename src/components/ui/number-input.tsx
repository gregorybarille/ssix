import { useState, type ComponentProps } from "react";
import { Input } from "./input";

interface NumberInputProps
  extends Omit<ComponentProps<typeof Input>, "type" | "value" | "onChange" | "onBlur"> {
  value: number;
  /** The number a text stands for, held to its range; `undefined` when it holds none. */
  parse: (text: string) => number | undefined;
  /** Called when the field is left with a different number. */
  onCommit: (value: number) => void;
}

/**
 * A number field whose text can be edited freely: emptied, or typed over digit
 * by digit. It becomes a number, held to its range, only when the field is
 * left. A text without a number gives way to `value` again.
 */
export function NumberInput({ value, parse, onCommit, ...props }: NumberInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      {...props}
      type="number"
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === null) return;
        setDraft(null);
        const parsed = parse(draft);
        if (parsed !== undefined && parsed !== value) onCommit(parsed);
      }}
    />
  );
}

interface OptionalNumberInputProps
  extends Omit<ComponentProps<typeof Input>, "type" | "value" | "onChange" | "onBlur"> {
  /** `undefined` leaves the field empty. */
  value: number | undefined;
  /** The number a text stands for, held to its range; `undefined` when it holds none. */
  parse: (text: string) => number | undefined;
  onChange: (value: number | undefined) => void;
}

/**
 * The same for a number a form may leave unset. The form holds the number from
 * the first digit, as Enter saves it without leaving the field; what was typed
 * stays on screen until the field is left, and only then shows its range.
 */
export function OptionalNumberInput({ value, parse, onChange, ...props }: OptionalNumberInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      {...props}
      type="number"
      value={draft ?? value ?? ""}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(parse(e.target.value));
      }}
      onBlur={() => setDraft(null)}
    />
  );
}
