import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("ConnectionForm with remote and dynamic forwards", () => {
  const gateway = { gateway_host: "bastion", gateway_port: 2200, gateway_credential_id: "cred-1" };

  const remoteForward: Connection = {
    ...direct,
    ...gateway,
    type: "remote_forward",
    remote_port: 8080,
    destination_host: "127.0.0.1",
    destination_port: 3000,
  };
  const dynamicForward: Connection = {
    ...direct,
    ...gateway,
    type: "dynamic_forward",
    local_port: 1080,
  };

  it("offers every kind, existing tabs first", () => {
    expect(CONNECTION_KIND_TABS.map((tab) => tab.type)).toEqual([
      "direct",
      "port_forward",
      "jump_shell",
      "remote_forward",
      "dynamic_forward",
    ]);
  });

  it("asks for the remote port when the remote forward tab is chosen", () => {
    renderForm(null);
    expect(screen.queryByTestId("connection-form-remote-port")).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("connection-form-kind-remoteforward"), { button: 0 });
    expect(screen.getByTestId("connection-form-remote-port")).toBeInTheDocument();
    expect(screen.queryByTestId("connection-form-local-port")).not.toBeInTheDocument();
    // Its target is on this machine's side, not somewhere behind the server.
    expect(screen.getByTestId("connection-form-target-host")).toHaveAttribute(
      "placeholder",
      "127.0.0.1",
    );
  });

  it("asks for the SOCKS port and no target when the dynamic forward tab is chosen", () => {
    renderForm(null);
    fireEvent.mouseDown(screen.getByTestId("connection-form-kind-dynamicforward"), { button: 0 });
    expect(screen.getByTestId("connection-form-socks-port")).toBeInTheDocument();
    expect(screen.queryByTestId("connection-form-target-host")).not.toBeInTheDocument();
  });

  it("shows a bad remote port beside its input and does not save", async () => {
    const { onSubmit } = renderForm(remoteForward);
    const input = screen.getByTestId("connection-form-remote-port");
    fireEvent.change(input, { target: { value: "70000" } });
    submit();
    await waitFor(() => expect(input).toHaveAttribute("aria-invalid", "true"));
    expect(input).toHaveAttribute("aria-describedby", "remote_port-error");
    expect(document.getElementById("remote_port-error")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls a missing dynamic forward port the SOCKS port and does not save", async () => {
    const { onSubmit } = renderForm(dynamicForward);
    const input = screen.getByTestId("connection-form-socks-port");
    fireEvent.change(input, { target: { value: "" } });
    submit();
    await waitFor(() => expect(input).toHaveAttribute("aria-invalid", "true"));
    expect(document.getElementById("local_port-error")).toHaveTextContent(
      "SOCKS port is required",
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps a remote forward's kind and ports when saved", async () => {
    const { onSubmit } = renderForm(remoteForward);
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
    const { onSubmit } = renderForm(dynamicForward);
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload).toMatchObject({ ...gateway, type: "dynamic_forward", local_port: 1080 });
    expect(payload).not.toHaveProperty("destination_host");
  });
});

describe("ConnectionForm bind address", () => {
  const dynamicForward: Connection = {
    id: "c2",
    name: "socks",
    host: "bastion",
    port: 22,
    type: "dynamic_forward",
    gateway_host: "bastion",
    gateway_port: 22,
    gateway_credential_id: "c1",
    local_port: 1080,
  };
  const field = () => screen.getByTestId("connection-form-bind-address");
  const warning = () => screen.queryByTestId("connection-form-bind-warning");
  const type = (value: string) => fireEvent.change(field(), { target: { value } });
  const clickSubmit = () =>
    fireEvent.click(screen.getByRole("button", { name: /create|save|update/i }));

  it("leaves the address out when empty, so the forward stays on loopback", async () => {
    const { onSubmit } = renderForm(dynamicForward);
    expect(field()).toHaveValue("");
    clickSubmit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].bind_address).toBeUndefined();
  });

  it("saves what was typed, without the spaces, and shows it when editing again", async () => {
    const { onSubmit } = renderForm(dynamicForward);
    type(" 10.0.0.5 ");
    clickSubmit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].bind_address).toBe("10.0.0.5");
    cleanup();
    renderForm({ ...dynamicForward, bind_address: "10.0.0.5" });
    expect(field()).toHaveValue("10.0.0.5");
  });

  it("refuses a name beside the field, until it is changed", async () => {
    const { onSubmit } = renderForm(dynamicForward);
    type("example.com");
    clickSubmit();
    await waitFor(() => expect(field()).toHaveAttribute("aria-invalid", "true"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/enter an ip address/i)).toHaveAttribute("role", "alert");
    type("10.0.0.5");
    expect(field()).not.toHaveAttribute("aria-invalid");
  });

  it("warns only when other machines could reach the forward", () => {
    renderForm(dynamicForward);
    expect(warning()).not.toBeInTheDocument();
    type("127.0.0.2");
    expect(warning()).not.toBeInTheDocument();
    type("example.com");
    expect(warning()).not.toBeInTheDocument();
    type("0.0.0.0");
    expect(warning()).toHaveTextContent(/no password/);
  });

  it("is offered on local and dynamic forwards only", () => {
    renderForm(null);
    expect(screen.queryByTestId("connection-form-bind-address")).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("connection-form-kind-localforward"), { button: 0 });
    expect(field()).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("connection-form-kind-remoteforward"), { button: 0 });
    expect(screen.queryByTestId("connection-form-bind-address")).not.toBeInTheDocument();
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
  it("offers password, SSH key and SSH agent", () => {
    expect(CREDENTIAL_KIND_TABS.map((tab) => tab.type)).toEqual(["password", "ssh_key", "agent"]);
  });

  it("asks an agent credential for nothing beyond its name and username", () => {
    expect(credentialFieldErrors({ name: "agent", username: "me", type: "agent" })).toEqual({});
    expect(credentialFieldErrors({ name: "agent", username: "", type: "agent" })).toEqual({
      username: "Username is required",
    });
  });
});
