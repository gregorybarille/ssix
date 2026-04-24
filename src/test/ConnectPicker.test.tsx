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
    expect(screen.queryByRole("searchbox", { name: /search connections/i })).toBeNull();
  });

  it("autofocuses the search input", () => {
    open();
    const input = screen.getByRole("searchbox", { name: /search connections/i });
    expect(document.activeElement).toBe(input);
  });

  it("filters by name, host, and tag tokens (AND semantics)", () => {
    open();
    const input = screen.getByRole("searchbox", { name: /search connections/i });
    fireEvent.change(input, { target: { value: "production db" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("db-bastion");
  });

  it("ArrowDown / ArrowUp wrap and update aria-selected", () => {
    open();
    const input = screen.getByRole("searchbox", { name: /search connections/i });
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
    const input = screen.getByRole("searchbox", { name: /search connections/i });
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
    const input = screen.getByRole("searchbox", { name: /search connections/i });
    expect(input.getAttribute("aria-activedescendant")).toBe("connect-picker-row-0");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe("connect-picker-row-1");
  });

  it("shows a no-matches message when query has no hits", () => {
    open();
    const input = screen.getByRole("searchbox", { name: /search connections/i });
    fireEvent.change(input, { target: { value: "zzznomatch" } });
    expect(screen.getByText(/No matches for/)).toBeInTheDocument();
  });
});
