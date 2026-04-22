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
});
