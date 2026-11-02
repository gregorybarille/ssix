import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NumberInput } from "@/components/ui/number-input";

function parseOneToTwenty(text: string): number | undefined {
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : undefined;
}

/** Holds the value, as a settings form does. */
function Harness({ onCommit }: { onCommit: (value: number) => void }) {
  const [value, setValue] = useState(5);
  return (
    <NumberInput
      data-testid="field"
      value={value}
      parse={parseOneToTwenty}
      onCommit={(next) => {
        onCommit(next);
        setValue(next);
      }}
    />
  );
}

function renderField() {
  const onCommit = vi.fn();
  render(<Harness onCommit={onCommit} />);
  return { field: screen.getByTestId("field"), onCommit };
}

describe("NumberInput", () => {
  it("can be emptied, and takes the value back when left empty", () => {
    const { field, onCommit } = renderField();
    fireEvent.change(field, { target: { value: "" } });
    expect(field).toHaveValue(null);

    fireEvent.blur(field);
    expect(field).toHaveValue(5);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("lets a number be typed digit by digit, and commits it when left", () => {
    const { field, onCommit } = renderField();
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.change(field, { target: { value: "1" } });
    fireEvent.change(field, { target: { value: "10" } });
    expect(field).toHaveValue(10);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.blur(field);
    expect(field).toHaveValue(10);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(10);
  });

  it("holds the number to its range only when left", () => {
    const { field, onCommit } = renderField();
    fireEvent.change(field, { target: { value: "50" } });
    expect(field).toHaveValue(50);

    fireEvent.blur(field);
    expect(field).toHaveValue(20);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(20);
  });

  it("commits nothing when the number did not change", () => {
    const { field, onCommit } = renderField();
    fireEvent.blur(field);
    fireEvent.change(field, { target: { value: "5" } });
    fireEvent.blur(field);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("follows the value while it is not being edited", () => {
    const { rerender } = render(
      <NumberInput data-testid="field" value={5} parse={parseOneToTwenty} onCommit={vi.fn()} />,
    );
    rerender(
      <NumberInput data-testid="field" value={7} parse={parseOneToTwenty} onCommit={vi.fn()} />,
    );
    expect(screen.getByTestId("field")).toHaveValue(7);
  });
});
