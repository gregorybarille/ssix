import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PasswordInput } from "@/components/ui/password-input";

describe("PasswordInput", () => {
  it("renders as a password input by default", () => {
    render(<PasswordInput id="pw" value="" onChange={() => {}} />);
    const input = document.querySelector("input");
    expect(input).toBeTruthy();
    expect(input?.type).toBe("password");
  });

  it("toggles to text type when eye button is clicked", () => {
    render(<PasswordInput id="pw" value="secret" onChange={() => {}} />);
    const toggle = screen.getByRole("button", { name: /show password/i });
    fireEvent.click(toggle);
    const input = document.querySelector("input");
    expect(input?.type).toBe("text");
  });

  it("toggles back to password type on second click", () => {
    render(<PasswordInput id="pw" value="secret" onChange={() => {}} />);
    const toggle = screen.getByRole("button", { name: /show password/i });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: /hide password/i }));
    const input = document.querySelector("input");
    expect(input?.type).toBe("password");
  });

  it("toggle button is type=button to avoid accidental form submission", () => {
    render(<PasswordInput id="pw" value="" onChange={() => {}} />);
    const toggle = screen.getByRole("button");
    expect(toggle.getAttribute("type")).toBe("button");
  });

  /*
   * P2-A7: defaulting autoComplete lets password managers recognize
   * the field. The visibility toggle's pressed state must be exposed
   * via aria-pressed — the icon swap alone is not announced by AT.
   */
  it("defaults autoComplete to current-password and respects an override", () => {
    const { rerender } = render(<PasswordInput id="pw" value="" onChange={() => {}} />);
    expect(document.querySelector("input")?.getAttribute("autocomplete")).toBe(
      "current-password",
    );
    rerender(
      <PasswordInput id="pw" value="" onChange={() => {}} autoComplete="new-password" />,
    );
    expect(document.querySelector("input")?.getAttribute("autocomplete")).toBe(
      "new-password",
    );
  });

  it("exposes the visibility toggle's state via aria-pressed", () => {
    render(<PasswordInput id="pw" value="secret" onChange={() => {}} />);
    const toggle = screen.getByRole("button", { name: /show password/i });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    const toggleNow = screen.getByRole("button", { name: /hide password/i });
    expect(toggleNow).toHaveAttribute("aria-pressed", "true");
  });
});
