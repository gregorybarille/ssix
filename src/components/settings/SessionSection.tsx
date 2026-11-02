import type { SettingsSectionProps } from "./section";

/**
 * Session settings (roadmap: resilience). Owned by the resilience stream,
 * which adds the keepalive, auto-reconnect and session-log controls here
 * (`keepalive_interval`, `auto_reconnect`, `reconnect_max_attempts`,
 * `session_log_enabled`, `session_log_dir`). `SettingsPanel` puts no separator
 * around this section, so start with a `<Separator />` once it renders
 * something. Renders nothing until then.
 */
export function SessionSection(_props: SettingsSectionProps) {
  return null;
}
