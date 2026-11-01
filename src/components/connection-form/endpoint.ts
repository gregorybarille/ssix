import type { ConnectionType } from "@/types";

interface EndpointFields {
  host: string;
  port: number;
  gateway_host?: string;
  gateway_port?: number;
  destination_host?: string;
  destination_port?: number;
}

/**
 * The top-level host and port stored on a connection. Two-hop kinds mirror
 * their far end there so list views have a meaningful host to show. A dynamic
 * forward has no far end, so its SSH server stands in; any destination left
 * in the draft by another kind's tab is ignored.
 */
export function mirroredEndpoint(
  type: ConnectionType,
  form: EndpointFields,
): { host: string; port: number } {
  if (type === "direct") return { host: form.host, port: form.port };
  const firstHop = { host: form.gateway_host ?? "", port: form.gateway_port ?? 22 };
  if (type === "dynamic_forward") return firstHop;
  return {
    host: form.destination_host ?? firstHop.host,
    port: form.destination_port ?? firstHop.port,
  };
}
