import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ConnectionForm } from "@/components/ConnectionForm";

describe("ConnectionForm startup fields", () => {
  it("renders login command and remote path fields", () => {
    render(
      <ConnectionForm
        open
        onOpenChange={vi.fn()}
        credentials={[]}
        onSubmit={async () => {}}
      />
    );

    expect(screen.getByLabelText(/login command/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/remote path/i)).toBeInTheDocument();
  });

  it("loads login command and remote path from an existing connection", () => {
    render(
      <ConnectionForm
        open
        onOpenChange={vi.fn()}
        credentials={[]}
        onSubmit={async () => {}}
        connection={{
          id: "c1",
          name: "prod",
          host: "host",
          port: 22,
          type: "direct",
          login_command: "sudo su - deploy",
          remote_path: "/srv/app",
        }}
      />
    );

    expect(screen.getByDisplayValue("sudo su - deploy")).toBeInTheDocument();
    expect(screen.getByDisplayValue("/srv/app")).toBeInTheDocument();
  });
});
