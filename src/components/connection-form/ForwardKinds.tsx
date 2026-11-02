import type { ConnectionType } from "@/types";
import { PortField } from "../ConnectionFormFields";

/**
 * The kind tabs the connection form offers, in order. The labels and `ssh`
 * flags come from `KIND_LABELS` / `KIND_FLAGS` in `src/lib/sshTerms.ts`.
 * The `testId` is the tab's `data-testid` (see `e2e/helpers/selectors.ts`).
 */
export const CONNECTION_KIND_TABS: ReadonlyArray<{ type: ConnectionType; testId: string }> = [
  { type: "direct", testId: "connection-form-kind-direct" },
  { type: "port_forward", testId: "connection-form-kind-localforward" },
  { type: "jump_shell", testId: "connection-form-kind-jumphost" },
  { type: "remote_forward", testId: "connection-form-kind-remoteforward" },
  { type: "dynamic_forward", testId: "connection-form-kind-dynamicforward" },
];

/** The port inputs a kind may add, as the form holds them: raw text plus any error. */
export interface ForwardPortProps {
  inputs: { local_port: string; remote_port: string };
  errors: { local_port?: string; remote_port?: string };
  onChange: (key: "local_port" | "remote_port", raw: string) => void;
}

interface ForwardKindsProps {
  connectionType: ConnectionType;
  ports: ForwardPortProps;
}

/**
 * The one port a forward kind listens on, under the hop and target blocks:
 * the local port of a local forward (`ssh -L`), the port on the server of a
 * remote forward (`ssh -R`), the SOCKS port of a dynamic forward (`ssh -D`).
 */
export function ForwardKinds({ connectionType, ports }: ForwardKindsProps) {
  switch (connectionType) {
    case "port_forward":
      return (
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
              SSIX listens on <code>127.0.0.1:&lt;local port&gt;</code> and forwards each
              connection through the SSH server to the remote host, like{" "}
              <code>ssh -L</code>. The remote host is resolved by the SSH server.
            </>
          }
        />
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
              SSIX runs a SOCKS5 proxy on <code>127.0.0.1:&lt;SOCKS port&gt;</code> and the SSH
              server dials whatever its clients ask for, like <code>ssh -D</code>. Names are
              resolved by the SSH server.
            </>
          }
        />
      );
    default:
      return null;
  }
}
