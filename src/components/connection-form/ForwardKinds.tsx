import type { ConnectionType } from "@/types";
import { KIND_FLAGS, KIND_LABELS } from "@/lib/sshTerms";
import { DEFAULT_BIND_ADDRESS, bindAddressError, isLoopbackAddress } from "@/lib/bindAddress";
import { FieldError, PortField } from "../ConnectionFormFields";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

/** The Type dropdown's options, terminals first, with each kind's `ssh` flag. */
export const CONNECTION_KIND_CHOICES = (
  ["direct", "jump_shell", "port_forward", "remote_forward", "dynamic_forward"] as const
).map((type) => ({
  value: type,
  label: KIND_FLAGS[type] ? `${KIND_LABELS[type]} (${KIND_FLAGS[type]})` : KIND_LABELS[type],
}));

/** The port inputs a kind may add, as the form holds them: raw text plus any error. */
export interface ForwardPortProps {
  inputs: { local_port: string; remote_port: string };
  errors: { local_port?: string; remote_port?: string };
  onChange: (key: "local_port" | "remote_port", raw: string) => void;
}

/** The local address a local or dynamic forward listens on, as typed. */
export interface ForwardBindProps {
  value: string;
  error?: string;
  onChange: (raw: string) => void;
}

interface ForwardKindsProps {
  connectionType: ConnectionType;
  ports: ForwardPortProps;
  bind: ForwardBindProps;
}

/** The address field, which warns once what it holds lets other machines in. */
function BindAddressField({
  bind,
  warning,
}: {
  bind: ForwardBindProps;
  warning: string;
}) {
  const open =
    !bind.error && !bindAddressError(bind.value) && !isLoopbackAddress(bind.value);
  return (
    <div className="space-y-2">
      <Label htmlFor="bind_address">Bind Address</Label>
      <Input
        id="bind_address"
        type="text"
        placeholder={DEFAULT_BIND_ADDRESS}
        value={bind.value}
        onChange={(e) => bind.onChange(e.target.value)}
        data-testid="connection-form-bind-address"
        aria-invalid={bind.error ? true : undefined}
        aria-describedby={bind.error ? "bind_address-error" : "bind_address-help"}
      />
      {bind.error ? (
        <FieldError id="bind_address-error" message={bind.error} />
      ) : (
        <p id="bind_address-help" className="text-xs text-muted-foreground">
          The IP address on this computer to listen on. Empty means{" "}
          <code>{DEFAULT_BIND_ADDRESS}</code>, reachable from this computer only. Use{" "}
          <code>0.0.0.0</code> for every network.
        </p>
      )}
      {open && (
        <p
          role="status"
          className="text-xs text-yellow-600 dark:text-yellow-400"
          data-testid="connection-form-bind-warning"
        >
          {warning}
        </p>
      )}
    </div>
  );
}

/**
 * The one port a forward kind listens on, under the hop and target blocks:
 * the local port of a local forward (`ssh -L`), the port on the server of a
 * remote forward (`ssh -R`), the SOCKS port of a dynamic forward (`ssh -D`).
 */
export function ForwardKinds({ connectionType, ports, bind }: ForwardKindsProps) {
  switch (connectionType) {
    case "port_forward":
      return (
        <>
          <BindAddressField
            bind={bind}
            warning="Anyone who can reach this computer at this address can use the forward, with no password."
          />
          <PortField
            id="local_port"
            label="Local Port *"
            placeholder="9000"
            value={ports.inputs.local_port}
            onChange={(raw) => ports.onChange("local_port", raw)}
            error={ports.errors.local_port}
            testId="connection-form-local-port"
            help={
              <>
                SSIX listens on this port and forwards each
                connection through the SSH server to the remote host, like{" "}
                <code>ssh -L</code>. The remote host is resolved by the SSH server.
              </>
            }
          />
        </>
      );
    case "remote_forward":
      return (
        <PortField
          id="remote_port"
          label="Remote Port *"
          placeholder="8080"
          value={ports.inputs.remote_port}
          onChange={(raw) => ports.onChange("remote_port", raw)}
          error={ports.errors.remote_port}
          testId="connection-form-remote-port"
          help={
            <>
              The SSH server listens on this port on its own loopback and each connection
              comes back to the local target, like <code>ssh -R</code>. The local target is
              resolved on this machine.
            </>
          }
        />
      );
    case "dynamic_forward":
      return (
        <>
          <BindAddressField
            bind={bind}
            warning="Anyone who can reach this computer at this address can use the proxy, with no password, to reach whatever the SSH server can."
          />
          <PortField
            id="local_port"
            label="SOCKS Port *"
            placeholder="1080"
            value={ports.inputs.local_port}
            onChange={(raw) => ports.onChange("local_port", raw)}
            error={ports.errors.local_port}
            testId="connection-form-socks-port"
            help={
              <>
                SSIX runs a SOCKS5 proxy on this port and the SSH
                server dials whatever its clients ask for, like <code>ssh -D</code>. Names are
                resolved by the SSH server.
              </>
            }
          />
        </>
      );
    default:
      return null;
  }
}
