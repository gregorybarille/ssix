import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConnectionForm } from "@/components/ConnectionForm";
import type { ConnectionFormSectionProps } from "@/components/connection-form/advanced";
import {
  advancedFromConnection,
  advancedPayload,
  serializeAdvanced,
} from "@/components/connection-form/advanced";
import { CONNECTION_KIND_TABS } from "@/components/connection-form/ForwardKinds";
import { CREDENTIAL_KIND_TABS } from "@/components/credential-form/kinds";
import { credentialFieldErrors } from "@/lib/credentialValidation";
import type { Connection, Credential } from "@/types";

// What a stream's section does: read `advanced`, change it through `onChange`.
vi.mock("@/components/connection-form/AuthOptions", () => ({
  AuthOptions: ({ advanced, onChange }: ConnectionFormSectionProps) => (
    <button
      type="button"
      data-testid="section-probe"
      onClick={() => onChange({ folder: "prod/us" })}
    >
      {advanced.folder ?? "no folder"}
    </button>
  ),
}));

const credential: Credential = {
  id: "cred-1",
  name: "deploy",
  username: "deploy",
  type: "password",
};

const direct: Connection = {
  id: "conn-1",
  name: "web",
  host: "web.example",
  port: 22,
  type: "direct",
  credential_id: "cred-1",
  tags: [],
};

const options = {
  agent_forwarding: true,
  keepalive_interval: 15,
  auto_reconnect: false,
  log_session: true,
  font_family: "Fira Code",
  font_size: 16,
  color_scheme: "teal",
  folder: "prod/eu",
};

function renderForm(connection: Connection | null) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  render(
    <ConnectionForm
      open
      onOpenChange={onOpenChange}
      connection={connection}
      credentials={[credential]}
      onSubmit={onSubmit}
    />,
  );
  return { onSubmit, onOpenChange };
}

const submit = () => fireEvent.click(screen.getByTestId("connection-form-submit"));

describe("ConnectionForm advanced options", () => {
  it("hands a saved connection's options to the sections", () => {
    renderForm({ ...direct, ...options });
    expect(screen.getByTestId("section-probe")).toHaveTextContent("prod/eu");
  });

  it("submits a saved connection's options unchanged", async () => {
    const { onSubmit } = renderForm({ ...direct, ...options });
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject(options);
  });

  it("submits what a section changed, keeping the rest", async () => {
    const { onSubmit } = renderForm({ ...direct, ...options });
    fireEvent.click(screen.getByTestId("section-probe"));
    expect(screen.getByTestId("section-probe")).toHaveTextContent("prod/us");
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ ...options, folder: "prod/us" });
  });

  it("leaves unset options out of the payload of an old connection", async () => {
    const { onSubmit } = renderForm(direct);
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.agent_forwarding).toBe(false);
    // What reaches the backend: IPC serializes to JSON, which drops `undefined`.
    const sentOverIpc = JSON.parse(JSON.stringify(payload));
    for (const key of ["keepalive_interval", "auto_reconnect", "log_session", "folder"]) {
      expect(sentOverIpc).not.toHaveProperty(key);
    }
  });

  it("closes without asking when nothing changed", () => {
    const { onOpenChange } = renderForm({ ...direct, ...options });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText("Discard unsaved changes?")).not.toBeInTheDocument();
  });

  it("asks before dropping a change a section made", () => {
    const { onOpenChange } = renderForm({ ...direct, ...options });
    fireEvent.click(screen.getByTestId("section-probe"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();
  });
});

describe("ConnectionForm with the kinds it does not offer yet", () => {
  const gateway = { gateway_host: "bastion", gateway_port: 2200, gateway_credential_id: "cred-1" };

  it("offers the same three kind tabs as before", () => {
    expect(CONNECTION_KIND_TABS.map((tab) => tab.type)).toEqual([
      "direct",
      "port_forward",
      "jump_shell",
    ]);
  });

  it("keeps a remote forward's kind and ports when saved", async () => {
    const { onSubmit } = renderForm({
      ...direct,
      ...gateway,
      type: "remote_forward",
      remote_port: 8080,
      destination_host: "127.0.0.1",
      destination_port: 3000,
    });
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      ...gateway,
      type: "remote_forward",
      remote_port: 8080,
      destination_host: "127.0.0.1",
      destination_port: 3000,
    });
  });

  it("keeps a dynamic forward's kind and port when saved, with no destination", async () => {
    const { onSubmit } = renderForm({
      ...direct,
      ...gateway,
      type: "dynamic_forward",
      local_port: 1080,
    });
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload).toMatchObject({ ...gateway, type: "dynamic_forward", local_port: 1080 });
    expect(payload).not.toHaveProperty("destination_host");
  });
});

describe("advanced helpers", () => {
  it("reads every option of a saved connection", () => {
    expect(advancedFromConnection({ ...direct, ...options })).toEqual(options);
  });

  it("defaults agent forwarding to off and everything else to unset", () => {
    expect(advancedPayload(advancedFromConnection(direct))).toEqual({ agent_forwarding: false });
  });

  it("serializes independently of key order, and sees each option", () => {
    const reversed = Object.fromEntries(Object.entries(options).reverse());
    expect(serializeAdvanced(reversed)).toBe(serializeAdvanced(options));
    for (const key of Object.keys(options)) {
      const without = { ...options, [key]: undefined };
      expect(serializeAdvanced(without)).not.toBe(serializeAdvanced(options));
    }
  });
});

describe("credential kinds", () => {
  it("offers the same two tabs as before: the SSH agent is not one yet", () => {
    expect(CREDENTIAL_KIND_TABS.map((tab) => tab.type)).toEqual(["password", "ssh_key"]);
  });

  it("asks an agent credential for nothing beyond its name and username", () => {
    expect(credentialFieldErrors({ name: "agent", username: "me", type: "agent" })).toEqual({});
    expect(credentialFieldErrors({ name: "agent", username: "", type: "agent" })).toEqual({
      username: "Username is required",
    });
  });
});
