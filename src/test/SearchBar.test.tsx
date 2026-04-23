import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SearchBar } from "@/components/SearchBar";

describe("SearchBar", () => {
  it("renders with placeholder", () => {
    render(
      <SearchBar
        value=""
        onChange={vi.fn()}
        onSearch={vi.fn()}
        placeholder="Find servers..."
      />
    );
    expect(screen.getByPlaceholderText("Find servers...")).toBeInTheDocument();
  });

  it("calls onChange and onSearch when typing", () => {
    const onChange = vi.fn();
    const onSearch = vi.fn();
    render(
      <SearchBar value="" onChange={onChange} onSearch={onSearch} />
    );
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "prod" } });
    expect(onChange).toHaveBeenCalledWith("prod");
    expect(onSearch).toHaveBeenCalledWith("prod");
  });

  it("shows clear button when value is present", () => {
    render(
      <SearchBar value="prod" onChange={vi.fn()} onSearch={vi.fn()} />
    );
    expect(
      screen.getByRole("button", { name: /clear search/i })
    ).toBeInTheDocument();
  });

  it("does not show clear button when value is empty", () => {
    render(
      <SearchBar value="" onChange={vi.fn()} onSearch={vi.fn()} />
    );
    expect(
      screen.queryByRole("button", { name: /clear search/i })
    ).not.toBeInTheDocument();
  });
});
