import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TagGroupGrid } from "@/components/TagGroupGrid";
import type { Connection } from "@/types";

const direct = (id: string, name: string, tags?: string[]): Connection => ({
  id,
  name,
  host: `${name}.example`,
  port: 22,
  type: "direct",
  tags,
});

const portfwd = (id: string, name: string, tags?: string[]): Connection => ({
  id,
  name,
  host: name,
  port: 22,
  type: "port_forward",
  gateway_host: "gw",
  gateway_port: 22,
  gateway_credential_id: "c",
  local_port: 9000,
  destination_host: "d",
  destination_port: 80,
  tags,
});

describe("TagGroupGrid", () => {
  it("renders one tile per distinct tag plus an Untagged tile", () => {
    render(
      <TagGroupGrid
        connections={[
          direct("1", "alpha", ["prod"]),
          direct("2", "beta", ["prod", "db"]),
          direct("3", "gamma"),
        ]}
        onConnectAll={vi.fn()}
        onScpAll={vi.fn()}
      />,
    );
    expect(screen.getByTestId("tag-group-prod")).toBeInTheDocument();
    expect(screen.getByTestId("tag-group-db")).toBeInTheDocument();
    expect(screen.getByTestId("tag-group-untagged")).toBeInTheDocument();
  });

  it("disables actions when no actionable hosts are in a group", () => {
    render(
      <TagGroupGrid
        connections={[portfwd("1", "tunnel", ["edge"])]}
        onConnectAll={vi.fn()}
        onScpAll={vi.fn()}
      />,
    );
    const connectBtn = screen.getByTestId("tag-connect-all-edge");
    const scpBtn = screen.getByTestId("tag-scp-all-edge");
    expect(connectBtn).toBeDisabled();
    expect(scpBtn).toBeDisabled();
  });

  it("invokes onConnectAll with the group when clicked", () => {
    const onConnectAll = vi.fn();
    render(
      <TagGroupGrid
        connections={[direct("1", "a", ["prod"])]}
        onConnectAll={onConnectAll}
        onScpAll={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("tag-connect-all-prod"));
    expect(onConnectAll).toHaveBeenCalledTimes(1);
    expect(onConnectAll.mock.calls[0][0].label).toBe("prod");
    expect(onConnectAll.mock.calls[0][0].connections).toHaveLength(1);
  });

  it("filters by query against tag label only", () => {
    render(
      <TagGroupGrid
        connections={[
          direct("1", "alpha", ["prod"]),
          direct("2", "beta", ["staging"]),
        ]}
        query="prod"
        onConnectAll={vi.fn()}
        onScpAll={vi.fn()}
      />,
    );
    expect(screen.getByTestId("tag-group-prod")).toBeInTheDocument();
    expect(screen.queryByTestId("tag-group-staging")).toBeNull();
  });

  it("shows empty state when there are no connections", () => {
    render(
      <TagGroupGrid
        connections={[]}
        onConnectAll={vi.fn()}
        onScpAll={vi.fn()}
      />,
    );
    expect(screen.getByText("No connections yet")).toBeInTheDocument();
  });

  it("shows 'no matching tags' when query filters everything", () => {
    render(
      <TagGroupGrid
        connections={[direct("1", "a", ["prod"])]}
        query="zzz"
        onConnectAll={vi.fn()}
        onScpAll={vi.fn()}
      />,
    );
    expect(screen.getByText("No matching tags")).toBeInTheDocument();
  });
});
