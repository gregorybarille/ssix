import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
