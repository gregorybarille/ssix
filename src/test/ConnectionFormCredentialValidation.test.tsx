import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionForm } from "@/components/ConnectionForm";
import type { Credential } from "@/types";
import { chooseSelectValue } from "./radixSelect";

const credentials: Credential[] = [
  { id: "c1", name: "default", username: "ubuntu", type: "password" },
  { id: "c2", name: "taken-name", username: "root", type: "password" },
];

function renderForm(props: Partial<Parameters<typeof ConnectionForm>[0]> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCreateCredential = vi.fn(async (data: Omit<Credential, "id">) => ({
    ...data,
    id: "new-cred",
  }));
  render(
    <ConnectionForm
      open
      onOpenChange={vi.fn()}
      credentials={credentials}
      onSubmit={onSubmit}
      onCreateCredential={onCreateCredential}
      {...props}
    />,
  );
  return { onSubmit, onCreateCredential };
}

const submit = () =>
  fireEvent.submit(screen.getByRole("button", { name: /create/i }).closest("form")!);

function fillDirect() {
  fireEvent.change(screen.getByLabelText(/connection name/i), { target: { value: "web" } });
  fireEvent.change(screen.getByLabelText(/host \*/i), { target: { value: "10.0.0.1" } });
}

describe("ConnectionForm credential validation", () => {
  it("requires a saved credential and marks the picker invalid", async () => {
    const { onSubmit } = renderForm();
    fillDirect();
    submit();
    const message = await screen.findByText("Credential is required");
    expect(message).toHaveAttribute("role", "alert");
    const picker = screen.getByRole("combobox", { name: "Credential" });
    expect(picker).toHaveAttribute("aria-invalid", "true");
    expect(picker).toHaveAttribute("aria-describedby", message.id);
    expect(picker).toHaveAttribute("aria-required", "true");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("clears the error once a credential is picked and then saves it", async () => {
    const { onSubmit } = renderForm();
    fillDirect();
    submit();
    await screen.findByText("Credential is required");
    const picker = screen.getByRole("combobox", { name: "Credential" });
    chooseSelectValue(picker, "c1");
    expect(screen.queryByText("Credential is required")).not.toBeInTheDocument();
    expect(picker).not.toHaveAttribute("aria-invalid");
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ type: "direct", credential_id: "c1" });
  });

  it("asks for the destination credential on a jump shell", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.click(screen.getByRole("tab", { name: "Jump Shell" }));
    fireEvent.change(screen.getByLabelText(/connection name/i), { target: { value: "jump" } });
    fireEvent.change(screen.getByLabelText(/gateway host/i), { target: { value: "gw" } });
    fireEvent.change(screen.getByLabelText(/destination host/i), { target: { value: "db" } });
    chooseSelectValue(screen.getByRole("combobox", { name: /gateway credential/i }), "c1");
    submit();
    expect(await screen.findByText("Destination credential is required")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Destination credential" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not ask a port forward for a destination credential", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    await user.click(screen.getByRole("tab", { name: "Port Forward" }));
    fireEvent.change(screen.getByLabelText(/connection name/i), { target: { value: "pf" } });
    fireEvent.change(screen.getByLabelText(/gateway host/i), { target: { value: "gw" } });
    fireEvent.change(screen.getByLabelText(/destination host/i), { target: { value: "db" } });
    fireEvent.change(screen.getByLabelText(/local port/i), { target: { value: "15432" } });
    chooseSelectValue(screen.getByRole("combobox", { name: /gateway credential/i }), "c1");
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      type: "port_forward",
      gateway_credential_id: "c1",
      credential_id: undefined,
    });
  });

  it("keeps the picked credential when the save fails on another field", async () => {
    renderForm();
    const picker = screen.getByRole("combobox", { name: "Credential" });
    chooseSelectValue(picker, "c1");
    submit();
    await screen.findByText("Connection name is required");
    expect(picker).toHaveTextContent("default");
    expect(screen.queryByText("Credential is required")).not.toBeInTheDocument();
  });

  it("flags every missing inline password field without creating a credential", async () => {
    const user = userEvent.setup();
    const { onSubmit, onCreateCredential } = renderForm();
    fillDirect();
    await user.click(screen.getByRole("tab", { name: "Password" }));
    submit();
    expect(await screen.findByText("Username is required")).toBeInTheDocument();
    expect(screen.getByText("Password is required")).toBeInTheDocument();
    expect(screen.getByLabelText(/username \*/i)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/^password \*/i)).toHaveAttribute("aria-invalid", "true");
    expect(onCreateCredential).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/username \*/i), { target: { value: "root" } });
    expect(screen.queryByText("Username is required")).not.toBeInTheDocument();
  });

  it("does not create the inline credential when a connection field is missing", async () => {
    const user = userEvent.setup();
    const { onCreateCredential } = renderForm();
    fireEvent.change(screen.getByLabelText(/connection name/i), { target: { value: "web" } });
    await user.click(screen.getByRole("tab", { name: "Password" }));
    fireEvent.change(screen.getByLabelText(/username \*/i), { target: { value: "root" } });
    fireEvent.change(screen.getByLabelText(/^password \*/i), { target: { value: "s3cret" } });
    submit();
    await screen.findByText("Host is required");
    expect(onCreateCredential).not.toHaveBeenCalled();
  });

  it("requires the private key path for inline SSH key auth", async () => {
    const user = userEvent.setup();
    const { onCreateCredential } = renderForm();
    fillDirect();
    await user.click(screen.getByRole("tab", { name: "SSH Key" }));
    fireEvent.change(screen.getByLabelText(/username \*/i), { target: { value: "root" } });
    submit();
    expect(await screen.findByText("Private key path is required")).toBeInTheDocument();
    expect(screen.getByLabelText(/private key path/i)).toHaveAttribute("aria-invalid", "true");
    expect(onCreateCredential).not.toHaveBeenCalled();
  });

  it("rejects a saved inline name that is taken, keeping the checkbox ticked", async () => {
    const user = userEvent.setup();
    const { onCreateCredential } = renderForm();
    fillDirect();
    await user.click(screen.getByRole("tab", { name: "Password" }));
    fireEvent.change(screen.getByLabelText(/username \*/i), { target: { value: "root" } });
    fireEvent.change(screen.getByLabelText(/^password \*/i), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByLabelText(/save as a named credential/i));
    fireEvent.change(screen.getByLabelText(/credential name \*/i), {
      target: { value: "taken-name" },
    });
    submit();
    const message = await screen.findByText("A credential named 'taken-name' already exists");
    expect(screen.getByLabelText(/credential name \*/i)).toHaveAttribute(
      "aria-describedby",
      message.id,
    );
    expect(screen.getByLabelText(/save as a named credential/i)).toBeChecked();
    expect(onCreateCredential).not.toHaveBeenCalled();
  });

  it("creates the inline credential and saves the connection with it", async () => {
    const user = userEvent.setup();
    const { onSubmit, onCreateCredential } = renderForm();
    fillDirect();
    await user.click(screen.getByRole("tab", { name: "SSH Key" }));
    fireEvent.change(screen.getByLabelText(/username \*/i), { target: { value: "root" } });
    fireEvent.change(screen.getByLabelText(/private key path/i), {
      target: { value: "~/.ssh/id_ed25519" },
    });
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onCreateCredential.mock.calls[0][0]).toMatchObject({
      username: "root",
      type: "ssh_key",
      private_key_path: "~/.ssh/id_ed25519",
      is_private: true,
    });
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ credential_id: "new-cred" });
  });
});
