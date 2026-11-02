import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TerminalOptions } from "@/components/connection-form/TerminalOptions";
import { TERMINAL_PALETTES } from "@/lib/terminalTheme";
import type { ConnectionAdvanced } from "@/types";

function renderOptions(advanced: Partial<ConnectionAdvanced> = {}) {
  const onChange = vi.fn();
  render(<TerminalOptions advanced={advanced as ConnectionAdvanced} onChange={onChange} />);
  return onChange;
}

// What Radix Select calls and jsdom does not have.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

async function pick(testId: string, name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByTestId(testId));
  await user.click(await screen.findByRole("option", { name }));
}

describe("TerminalOptions", () => {
  it("defaults to the app's settings and theme", () => {
    renderOptions();
    expect(screen.getByTestId("connection-form-font-family")).toHaveTextContent("Use app setting");
    expect(screen.getByTestId("connection-form-font-size")).toHaveTextContent("Use app setting");
    expect(screen.getByTestId("connection-form-color-scheme")).toHaveTextContent(
      "Follow the app theme",
    );
    expect(screen.queryByTestId("connection-form-color-scheme-error")).toBeNull();
  });

  it.each(["", "   "])("takes a stored blank of %j for unset", (blank) => {
    renderOptions({ font_family: blank, color_scheme: blank });
    expect(screen.getByTestId("connection-form-font-family")).toHaveTextContent("Use app setting");
    expect(screen.getByTestId("connection-form-color-scheme")).toHaveTextContent(
      "Follow the app theme",
    );
    expect(screen.queryByTestId("connection-form-color-scheme-error")).toBeNull();
  });

  it("shows what is saved", () => {
    renderOptions({ font_family: "Fira Code", font_size: 16, color_scheme: "dracula" });
    expect(screen.getByTestId("connection-form-font-family")).toHaveTextContent("Fira Code");
    expect(screen.getByTestId("connection-form-font-size")).toHaveTextContent("16px");
    expect(screen.getByTestId("connection-form-color-scheme")).toHaveTextContent("Dracula");
  });

  it("offers every palette", async () => {
    renderOptions();
    await userEvent.setup().click(screen.getByTestId("connection-form-color-scheme"));
    for (const { label } of TERMINAL_PALETTES) {
      expect(await screen.findByRole("option", { name: label })).toBeInTheDocument();
    }
  });

  it("sets a scheme", async () => {
    const onChange = renderOptions();
    await pick("connection-form-color-scheme", "Nord");
    expect(onChange).toHaveBeenLastCalledWith({ color_scheme: "nord" });
  });

  it("clears a scheme back to the app's", async () => {
    const onChange = renderOptions({ color_scheme: "nord" });
    await pick("connection-form-color-scheme", "Follow the app theme");
    expect(onChange).toHaveBeenLastCalledWith({ color_scheme: undefined });
  });

  it("sets a font size as a number", async () => {
    const onChange = renderOptions();
    await pick("connection-form-font-size", "16px");
    expect(onChange).toHaveBeenLastCalledWith({ font_size: 16 });
  });

  it("clears a font size back to the app's", async () => {
    const onChange = renderOptions({ font_size: 16 });
    await pick("connection-form-font-size", "Use app setting");
    expect(onChange).toHaveBeenLastCalledWith({ font_size: undefined });
  });

  it("keeps a saved font the list does not offer visible", () => {
    renderOptions({ font_family: "Berkeley Mono", font_size: 13 });
    expect(screen.getByTestId("connection-form-font-family")).toHaveTextContent("Berkeley Mono");
    expect(screen.getByTestId("connection-form-font-size")).toHaveTextContent("13px");
  });

  it("explains a stored scheme this build does not know, tied to its field", () => {
    renderOptions({ color_scheme: "retired-palette" });
    const trigger = screen.getByTestId("connection-form-color-scheme");
    expect(trigger).toHaveTextContent("retired-palette (no longer available)");
    const error = screen.getByTestId("connection-form-color-scheme-error");
    expect(error).toHaveTextContent('"retired-palette" is no longer available');
    expect(trigger).toHaveAttribute("aria-invalid", "true");
    expect(trigger.getAttribute("aria-describedby")).toBe(error.id);
  });

  it("takes the explanation away once another scheme is picked", async () => {
    const onChange = renderOptions({ color_scheme: "retired-palette" });
    await pick("connection-form-color-scheme", "Dracula");
    expect(onChange).toHaveBeenLastCalledWith({ color_scheme: "dracula" });
  });
});
