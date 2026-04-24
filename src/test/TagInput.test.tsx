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
  it("does NOT commit on Space (multi-word tags are valid; P2-A9)", () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText("add") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "needs review" } });
    fireEvent.keyDown(input, { key: " " });
    // Buffer is unchanged, no chip created.
    expect(screen.getByTestId("dump").textContent).toBe("");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("dump").textContent).toBe("needs review");
  });

  it("creates a chip when pressing enter", () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText("add");
    fireEvent.change(input, { target: { value: "beta" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("dump").textContent).toBe("beta");
  });

  it("creates a chip when pressing comma", () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText("add");
    fireEvent.change(input, { target: { value: "gamma" } });
    fireEvent.keyDown(input, { key: "," });
    expect(screen.getByTestId("dump").textContent).toBe("gamma");
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

  it("wraps the chip strip in a role=list with one listitem per tag", () => {
    render(<Harness initial={["a", "b", "c"]} />);
    const list = screen.getByRole("list", { name: /tags/i });
    expect(list).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
});
