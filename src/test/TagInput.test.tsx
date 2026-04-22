import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { TagInput } from "@/components/ui/tag-input";

function Harness({ initial = [] as string[] }: { initial?: string[] }) {
  const [tags, setTags] = useState<string[]>(initial);
  return (
    <div>
      <TagInput value={tags} onChange={setTags} placeholder="add" />
      <div data-testid="dump">{tags.join("|")}</div>
    </div>
  );
}

describe("TagInput", () => {
  it("creates a chip when pressing space", () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText("add");
    fireEvent.change(input, { target: { value: "alpha" } });
    fireEvent.keyDown(input, { key: " " });
    expect(screen.getByTestId("dump").textContent).toBe("alpha");
  });

  it("creates a chip when pressing enter", () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText("add");
    fireEvent.change(input, { target: { value: "beta" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("dump").textContent).toBe("beta");
  });

  it("dedupes tags case-insensitively", () => {
    render(<Harness initial={["Prod"]} />);
    const input = screen.getByPlaceholderText("");
    fireEvent.change(input, { target: { value: "prod" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("dump").textContent).toBe("Prod");
  });

  it("removes the last chip on backspace when the buffer is empty", () => {
    render(<Harness initial={["one", "two"]} />);
    const input = screen.getByPlaceholderText("");
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(screen.getByTestId("dump").textContent).toBe("one");
  });

  it("removes a chip via its X button", () => {
    render(<Harness initial={["one", "two", "three"]} />);
    const remove = screen.getByLabelText("Remove tag two");
    fireEvent.click(remove);
    expect(screen.getByTestId("dump").textContent).toBe("one|three");
  });
});
