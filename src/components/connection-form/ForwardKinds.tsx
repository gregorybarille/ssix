import type { ConnectionType } from "@/types";
import { PortField } from "../ConnectionFormFields";

/**
 * The kind tabs the connection form offers, in order. Owned by the
 * forwards stream (roadmap: forwards), which appends `remote_forward` and
 * `dynamic_forward` here once they can be connected; the labels and `ssh`
 * flags come from `KIND_LABELS` / `KIND_FLAGS` in `src/lib/sshTerms.ts`.
 * The `testId` is the tab's `data-testid` (see `e2e/helpers/selectors.ts`).
 */
export const CONNECTION_KIND_TABS: ReadonlyArray<{ type: ConnectionType; testId: string }> = [
  { type: "direct", testId: "connection-form-kind-direct" },
  { type: "port_forward", testId: "connection-form-kind-localforward" },
  { type: "jump_shell", testId: "connection-form-kind-jumphost" },
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
 * The fields only a forward kind has, under the hop and target blocks:
 * today the local port of a local forward (`ssh -L`). The forwards stream
 * adds the remote port of a remote forward and the SOCKS port of a dynamic
 * forward here, reading and writing `ports` like the local port does.
 */
export function ForwardKinds({ connectionType, ports }: ForwardKindsProps) {
  if (connectionType !== "port_forward") return null;
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
}
