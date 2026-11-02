import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FolderPicker } from "@/components/FolderPicker";

const FOLDERS = ["prod", "prod/eu", "staging"];

function Harness({
  initial = "",
  onSubmit = () => {},
  folders = FOLDERS,
}: {
  initial?: string;
  onSubmit?: (value: string) => void;
  folders?: string[];
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      <FolderPicker id="f" aria-label="Folder" folders={folders} value={value} onChange={setValue} />
    </form>
  );
}

const options = () =>
  screen.queryAllByRole("option").map((option) => option.getAttribute("data-name"));
const field = () => screen.getByRole("combobox", { name: "Folder" });

describe("FolderPicker", () => {
  it("is closed until asked, and offers what matches the typed text", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(field()).toHaveAttribute("aria-expanded", "false");
    await user.tab();
    expect(options()).toEqual([]);
    await user.type(field(), "PRO");
    expect(field()).toHaveAttribute("aria-expanded", "true");
    expect(options()).toEqual(["prod", "prod/eu"]);
  });

  it("takes a clicked option and keeps the field focused", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(field(), "st");
    await user.click(screen.getByRole("option", { name: "staging" }));
    expect(field()).toHaveValue("staging");
    expect(field()).toHaveFocus();
    expect(options()).toEqual([]);
  });

  it("takes an option with the arrows and Enter, without submitting", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    await user.type(field(), "pro");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    const active = field().getAttribute("aria-activedescendant");
    expect(document.getElementById(active!)).toHaveTextContent("prod/eu");
    await user.keyboard("{Enter}");
    expect(field()).toHaveValue("prod/eu");
    expect(onSubmit).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("prod/eu");
  });

  it("submits a typed new path on Enter, even with similar folders offered", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    await user.type(field(), "pro{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("pro");
    expect(field()).toHaveValue("pro");
  });

  it("offers every folder from its button, whatever is typed", async () => {
    const user = userEvent.setup();
    render(<Harness initial="prod" />);
    await user.click(screen.getByTestId("folder-picker-toggle"));
    expect(options()).toEqual(FOLDERS);
    await user.click(screen.getByTestId("folder-picker-toggle"));
    expect(options()).toEqual([]);
  });

  it("offers them all from the arrows when nothing matches", async () => {
    const user = userEvent.setup();
    render(<Harness initial="new/path" />);
    await user.click(field());
    expect(options()).toEqual([]);
    await user.keyboard("{ArrowDown}");
    expect(options()).toEqual(FOLDERS);
  });

  it("has no button or list without folders", async () => {
    const user = userEvent.setup();
    render(<Harness folders={[]} />);
    expect(screen.queryByTestId("folder-picker-toggle")).not.toBeInTheDocument();
    await user.type(field(), "x{ArrowDown}");
    expect(options()).toEqual([]);
  });

  it("closes on blur", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(field(), "pro");
    await user.tab();
    expect(options()).toEqual([]);
  });

  it("takes Escape for itself while open, and leaves it alone once closed", async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    document.addEventListener("keydown", seen, true);
    try {
      render(<Harness />);
      await user.type(field(), "pro");
      fireEvent.keyDown(field(), { key: "Escape" });
      expect(options()).toEqual([]);
      expect(seen).not.toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));
      fireEvent.keyDown(field(), { key: "Escape" });
      expect(seen).toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));
    } finally {
      document.removeEventListener("keydown", seen, true);
    }
  });
});
