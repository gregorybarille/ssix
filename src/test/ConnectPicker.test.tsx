import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConnectPicker } from "@/components/ConnectPicker";
import { Connection, Credential } from "@/types";

const conns: Connection[] = [
  { id: "1", name: "prod-api", host: "api.prod", port: 22, type: "direct", tags: ["production"] },
  { id: "2", name: "staging-api", host: "api.staging", port: 22, type: "direct", tags: ["staging"], credential_id: "cred1" },
  { id: "3", name: "db-bastion", host: "10.0.0.5", port: 22, type: "direct", tags: ["production", "db"] },
];

const creds: Credential[] = [
  { id: "cred1", name: "staging-key", username: "deploy", type: "password", password: "secret" },
];

describe("ConnectPicker (command palette)", () => {
  let onConnect: ReturnType<typeof vi.fn>;
  let onOpenChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onConnect = vi.fn();
    onOpenChange = vi.fn();
  });

  function open() {
    render(
      <ConnectPicker
        open
        onOpenChange={onOpenChange}
        connections={conns}
        credentials={creds}
        onConnect={onConnect}
      />,
    );
  }

  it("renders all connections by default", () => {
    open();
    expect(screen.getByText("prod-api")).toBeInTheDocument();
    expect(screen.getByText("staging-api")).toBeInTheDocument();
    expect(screen.getByText("db-bastion")).toBeInTheDocument();
  });

  it("shows the credential name for connections that reference one", () => {
    open();
    expect(screen.getByText(/staging-key/)).toBeInTheDocument();
  });

  it("renders an empty state when no connections are configured", () => {
    render(
      <ConnectPicker
        open
        onOpenChange={onOpenChange}
        connections={[]}
        credentials={[]}
        onConnect={onConnect}
      />,
    );
    expect(screen.getByText(/No connections configured yet/)).toBeInTheDocument();
  });

  it("does not render the search input when closed", () => {
    render(
      <ConnectPicker
        open={false}
        onOpenChange={onOpenChange}
        connections={conns}
        credentials={creds}
        onConnect={onConnect}
      />,
    );
    expect(screen.queryByRole("combobox", { name: /search connections/i })).toBeNull();
  });

  it("autofocuses the search input", () => {
    open();
    const input = screen.getByRole("combobox", { name: /search connections/i });
    expect(document.activeElement).toBe(input);
  });

  it("renders the search input with the focus-visible ring class", () => {
    /*
     * Audit-3 follow-up P2#4: pins the switch from a bare <input>
     * to the shared <Input> primitive. Without this, a future
     * drive-by edit could revert the search field and silently
     * drop the focus-visible ring (it has no border to fall back
     * on — the ring is the only focus indicator inside the
     * picker shell).
     */
    open();
    const input = screen.getByRole("combobox", { name: /search connections/i });
    expect(input.className).toMatch(/focus-visible:ring-2/);
  });

  it("filters by name, host, and tag tokens (AND semantics)", () => {
    open();
    const input = screen.getByRole("combobox", { name: /search connections/i });
    fireEvent.change(input, { target: { value: "production db" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("db-bastion");
  });

  it("ArrowDown / ArrowUp wrap and update aria-selected", () => {
    open();
    const input = screen.getByRole("combobox", { name: /search connections/i });
    let active = screen
      .getAllByRole("option")
      .find((o) => o.getAttribute("aria-selected") === "true");
    expect(active).toHaveTextContent("prod-api");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    active = screen
      .getAllByRole("option")
      .find((o) => o.getAttribute("aria-selected") === "true");
    expect(active).toHaveTextContent("staging-api");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    active = screen
      .getAllByRole("option")
      .find((o) => o.getAttribute("aria-selected") === "true");
    expect(active).toHaveTextContent("prod-api");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    active = screen
      .getAllByRole("option")
      .find((o) => o.getAttribute("aria-selected") === "true");
    expect(active).toHaveTextContent("db-bastion");
  });

  it("Enter calls onConnect with the active row and closes", () => {
    open();
    const input = screen.getByRole("combobox", { name: /search connections/i });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect).toHaveBeenCalledWith(conns[1]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("clicking a row connects to that row", () => {
    open();
    fireEvent.click(screen.getByText("prod-api"));
    expect(onConnect).toHaveBeenCalledWith(conns[0]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("aria-activedescendant points at the active row", () => {
    open();
    const input = screen.getByRole("combobox", { name: /search connections/i });
    expect(input.getAttribute("aria-activedescendant")).toBe("connect-picker-row-0");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe("connect-picker-row-1");
  });

  it("shows a no-matches message when query has no hits", () => {
    open();
    const input = screen.getByRole("combobox", { name: /search connections/i });
    fireEvent.change(input, { target: { value: "zzznomatch" } });
    expect(screen.getByText(/No matches for/)).toBeInTheDocument();
  });

  /*
   * P2-A8: WAI-ARIA 1.2 combobox pattern. The input must expose
   * role=combobox + aria-expanded reflecting whether the listbox is
   * actually rendered + aria-autocomplete=list. Without these AT
   * announces a plain textbox and never tells the user there's a
   * listbox of suggestions to navigate.
   */
  it("exposes the combobox role with aria-expanded reflecting listbox visibility", () => {
    open();
    const input = screen.getByRole("combobox", { name: /search connections/i });
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(input).toHaveAttribute("aria-controls", "connect-picker-list");
    fireEvent.change(input, { target: { value: "zzznomatch" } });
    // No matches => no listbox is rendered, so aria-expanded must flip.
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).not.toHaveAttribute("aria-controls");
  });

  /*
   * Audit-3 P2#11: hover/keyboard race regression.
   *
   * The previous implementation used `onMouseEnter` to update the
   * active row. Whenever ArrowUp/Down ran scrollIntoView on the
   * newly-active row, the rows under a stationary cursor moved,
   * which fires synthetic `mouseenter` events for whichever row
   * passed under the cursor — clobbering the keyboard's selection.
   *
   * The fix uses `pointermove` to track real pointer motion and
   * gates `pointerenter` on it. We assert here that synthesizing a
   * pointerenter WITHOUT a preceding pointermove does NOT change
   * the keyboard-driven selection.
   */
  it("hover does not clobber keyboard selection without pointer movement", () => {
    open();
    const input = screen.getByRole("combobox");
    // ArrowDown twice → row index 2 (db-bastion).
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      "connect-picker-row-2",
    );

    // Simulate the bug: the scroll moves a different row under the
    // (stationary) cursor, firing pointerenter on row 0 WITHOUT a
    // preceding pointermove. Selection must NOT change.
    const row0 = document.querySelector('[data-index="0"]')!;
    fireEvent.pointerEnter(row0);
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      "connect-picker-row-2",
    );

    // After a real pointermove, hover IS allowed to take over.
    const list = document.getElementById("connect-picker-list")!;
    fireEvent.pointerMove(list);
    fireEvent.pointerEnter(row0);
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      "connect-picker-row-0",
    );
  });
});
