import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthOptions } from "@/components/connection-form/AuthOptions";
import { CredentialForm } from "@/components/CredentialForm";
import { invoke } from "@/lib/tauri";
import type { Credential } from "@/types";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));

const agentCredential: Credential = {
  id: "cred-agent",
  name: "laptop-agent",
  username: "deploy",
  type: "agent",
};

const tab = () => screen.getByTestId("credential-form-kind-agent");

describe("CredentialForm's SSH agent tab", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue({});
  });

  it("creates an agent credential with no secret in it", async () => {
    const onSubmit = vi.fn(async () => {});
    render(<CredentialForm open onOpenChange={vi.fn()} credential={null} onSubmit={onSubmit} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/credential name/i), "agent");
    await user.type(screen.getByTestId("credential-form-username"), "me");
    await user.click(tab());

    expect(screen.getByTestId("credential-form-agent-hint")).toHaveTextContent("SSH_AUTH_SOCK");
    expect(screen.queryByTestId("credential-form-password")).toBeNull();

    await user.click(screen.getByTestId("credential-form-submit"));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ name: "agent", username: "me", type: "agent" }),
    );
  });

  it("does not ask for a password typed on another tab", async () => {
    const onSubmit = vi.fn(async () => {});
    render(<CredentialForm open onOpenChange={vi.fn()} credential={null} onSubmit={onSubmit} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/credential name/i), "agent");
    await user.type(screen.getByTestId("credential-form-username"), "me");
    await user.type(screen.getByTestId("credential-form-password"), "typed-by-mistake");
    await user.click(tab());
    await user.click(screen.getByTestId("credential-form-submit"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(JSON.stringify(onSubmit.mock.calls)).not.toContain("typed-by-mistake");
  });

  it("opens an agent credential on its own tab and saves it unchanged", async () => {
    const onSubmit = vi.fn(async () => {});
    render(
      <CredentialForm open onOpenChange={vi.fn()} credential={agentCredential} onSubmit={onSubmit} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("credential-form")).toHaveAttribute("data-secrets-state", "loaded"),
    );
    expect(tab()).toHaveAttribute("aria-selected", "true");

    await userEvent.setup().click(screen.getByTestId("credential-form-submit"));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        id: "cred-agent",
        name: "laptop-agent",
        username: "deploy",
        type: "agent",
        keep_secrets: true,
      }),
    );
  });
});

describe("AuthOptions", () => {
  const checkbox = () => screen.getByTestId("connection-form-agent-forwarding");

  it("is off unless the connection enables it, and says what it risks", () => {
    render(<AuthOptions advanced={{}} onChange={vi.fn()} connectionType="direct" />);
    expect(checkbox()).toHaveAttribute("aria-checked", "false");
    const hint = document.getElementById(checkbox().getAttribute("aria-describedby")!);
    expect(hint).toHaveTextContent(/anyone with root on that server/i);
    expect(screen.getByLabelText(/forward ssh agent/i)).toBe(checkbox());
  });

  it("reports both directions", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<AuthOptions advanced={{}} onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(checkbox());
    expect(onChange).toHaveBeenLastCalledWith({ agent_forwarding: true });

    rerender(<AuthOptions advanced={{ agent_forwarding: true }} onChange={onChange} />);
    expect(checkbox()).toHaveAttribute("aria-checked", "true");
    await user.click(checkbox());
    expect(onChange).toHaveBeenLastCalledWith({ agent_forwarding: false });
  });

  it("is offered for shells only", () => {
    const { rerender } = render(
      <AuthOptions advanced={{}} onChange={vi.fn()} connectionType="jump_shell" />,
    );
    expect(checkbox()).toBeInTheDocument();
    for (const connectionType of ["port_forward", "remote_forward", "dynamic_forward"] as const) {
      rerender(<AuthOptions advanced={{}} onChange={vi.fn()} connectionType={connectionType} />);
      expect(screen.queryByTestId("connection-form-agent-forwarding")).toBeNull();
    }
  });
});
