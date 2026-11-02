import type { ConnectionFormSectionProps } from "./advanced";

/**
 * Session options of the connection form (roadmap: resilience). Owned by
 * the resilience stream, which adds the keepalive, auto-reconnect and
 * session-log controls here (`advanced.keepalive_interval`,
 * `advanced.auto_reconnect`, `advanced.log_session`; unset means "use the
 * setting"). Renders nothing until then.
 */
export function SessionOptions(_props: ConnectionFormSectionProps) {
  return null;
}
