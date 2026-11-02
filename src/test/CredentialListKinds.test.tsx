import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CredentialList } from "@/components/CredentialList";
import type { Credential } from "@/types";

const agent = { id: "a1", name: "laptop", username: "me", type: "agent" } as Credential;

describe("CredentialList", () => {
  it.each(["list", "tile"] as const)("names an agent credential in the %s layout", (layout) => {
    render(
      <CredentialList credentials={[agent]} onEdit={vi.fn()} onDelete={vi.fn()} layout={layout} />,
    );
    expect(screen.getByRole("listitem", { name: "laptop, SSH agent credential" })).toBeTruthy();
    expect(screen.getByText("SSH Agent")).toBeTruthy();
    expect(screen.queryByText("Password")).toBeNull();
  });
});
