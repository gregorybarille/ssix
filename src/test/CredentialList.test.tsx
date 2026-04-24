import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CredentialList } from "@/components/CredentialList";
import { Credential } from "@/types";

const mockCredentials: Credential[] = [
  { id: "1", name: "prod-key", username: "ubuntu", type: "ssh_key", private_key_path: "/home/user/.ssh/id_rsa" },
  { id: "2", name: "dev-pass", username: "admin", type: "password", password: "secret" },
];

describe("CredentialList", () => {
  it("renders empty state when no credentials", () => {
    render(
      <CredentialList
        credentials={[]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.getByText("No credentials yet")).toBeInTheDocument();
  });

  it("renders credentials", () => {
    render(
      <CredentialList
        credentials={mockCredentials}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.getByText("prod-key")).toBeInTheDocument();
    expect(screen.getByText("dev-pass")).toBeInTheDocument();
  });

  it("shows SSH Key badge for key credentials", () => {
    render(
      <CredentialList
        credentials={[mockCredentials[0]]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.getByText("SSH Key")).toBeInTheDocument();
  });

  it("shows Password badge for password credentials", () => {
    render(
      <CredentialList
        credentials={[mockCredentials[1]]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.getByText("Password")).toBeInTheDocument();
  });

  // ─── Tile layout ──────────────────────────────────────────────────────────

  it("renders a grid container in tile layout", () => {
    render(
      <CredentialList
        credentials={mockCredentials}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        layout="tile"
      />
    );
    expect(screen.getByTestId("credential-grid")).toBeInTheDocument();
  });

  it("renders credential names in tile layout", () => {
    render(
      <CredentialList
        credentials={mockCredentials}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        layout="tile"
      />
    );
    expect(screen.getByText("prod-key")).toBeInTheDocument();
    expect(screen.getByText("dev-pass")).toBeInTheDocument();
  });

  it("shows SSH Key and Password badges in tile layout", () => {
    render(
      <CredentialList
        credentials={mockCredentials}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        layout="tile"
      />
    );
    expect(screen.getByText("SSH Key")).toBeInTheDocument();
    expect(screen.getByText("Password")).toBeInTheDocument();
  });

  it("calls onEdit when Edit is clicked in tile layout", () => {
    const onEdit = vi.fn();
    render(
      <CredentialList
        credentials={[mockCredentials[0]]}
        onEdit={onEdit}
        onDelete={vi.fn()}
        layout="tile"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Edit credential / }));
    expect(onEdit).toHaveBeenCalledWith(mockCredentials[0]);
  });

  it("calls onDelete when Delete is clicked in tile layout", () => {
    const onDelete = vi.fn();
    render(
      <CredentialList
        credentials={[mockCredentials[1]]}
        onEdit={vi.fn()}
        onDelete={onDelete}
        layout="tile"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Delete credential / }));
    expect(onDelete).toHaveBeenCalledWith(mockCredentials[1].id);
  });

  it("shows Install button only for SSH key credentials in tile layout", () => {
    render(
      <CredentialList
        credentials={mockCredentials}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        layout="tile"
      />
    );
    // Only the ssh_key credential should have an install button
    const installBtns = screen.getAllByRole("button", { name: /^Install public key for / });
    expect(installBtns).toHaveLength(1);
  });
});
