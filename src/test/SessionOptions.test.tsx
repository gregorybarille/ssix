import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionOptions } from "@/components/connection-form/SessionOptions";
import { SessionSection } from "@/components/settings/SessionSection";
import type { AppSettings, ConnectionAdvanced } from "@/types";
import { chooseSelectValue } from "./radixSelect";

/** Holds the form's `advanced` state, so a control shows what it set. */
function FormHarness({
  initial,
  onChange,
}: {
  initial: ConnectionAdvanced;
  onChange: (partial: Partial<ConnectionAdvanced>) => void;
}) {
  const [advanced, setAdvanced] = useState(initial);
  return (
    <form>
      <SessionOptions
        advanced={advanced}
        onChange={(partial) => {
          onChange(partial);
          setAdvanced((current) => ({ ...current, ...partial }));
        }}
      />
    </form>
  );
}

describe("SessionOptions", () => {
  it("starts on the app's settings when nothing is overridden", () => {
    render(<FormHarness initial={{ agent_forwarding: false }} onChange={vi.fn()} />);
    expect(screen.getByTestId("connection-form-keepalive")).toHaveValue(null);
    expect(screen.getByTestId("connection-form-auto-reconnect")).toHaveTextContent(
      "Use app setting",
    );
    expect(screen.getByTestId("connection-form-log-session")).toHaveTextContent("Use app setting");
  });

  it("shows a saved connection's overrides, including an explicit 0 and off", () => {
    render(
      <FormHarness
        initial={{
          agent_forwarding: false,
          keepalive_interval: 0,
          auto_reconnect: false,
          log_session: true,
        }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("connection-form-keepalive")).toHaveValue(0);
    expect(screen.getByTestId("connection-form-auto-reconnect")).toHaveTextContent("Off");
    expect(screen.getByTestId("connection-form-log-session")).toHaveTextContent("On");
  });

  it("sets and clears the keepalive", () => {
    const onChange = vi.fn();
    render(<FormHarness initial={{ agent_forwarding: false }} onChange={onChange} />);
    const input = screen.getByTestId("connection-form-keepalive");

    fireEvent.change(input, { target: { value: "15" } });
    expect(onChange).toHaveBeenLastCalledWith({ keepalive_interval: 15 });

    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ keepalive_interval: undefined });
  });

  it("holds the keepalive to what the backend accepts", () => {
    const onChange = vi.fn();
    render(<FormHarness initial={{ agent_forwarding: false }} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("connection-form-keepalive"), {
      target: { value: "70000" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ keepalive_interval: 3600 });
  });

  it("maps the on/off choices to the stored override", () => {
    const onChange = vi.fn();
    render(<FormHarness initial={{ agent_forwarding: false }} onChange={onChange} />);
    const autoReconnect = screen.getByTestId("connection-form-auto-reconnect");
    const logSession = screen.getByTestId("connection-form-log-session");

    chooseSelectValue(autoReconnect, "off");
    expect(onChange).toHaveBeenLastCalledWith({ auto_reconnect: false });
    chooseSelectValue(autoReconnect, "on");
    expect(onChange).toHaveBeenLastCalledWith({ auto_reconnect: true });
    chooseSelectValue(autoReconnect, "default");
    expect(onChange).toHaveBeenLastCalledWith({ auto_reconnect: undefined });

    chooseSelectValue(logSession, "on");
    expect(onChange).toHaveBeenLastCalledWith({ log_session: true });
  });
});

describe("SessionSection", () => {
  const form = {
    keepalive_interval: 30,
    auto_reconnect: true,
    reconnect_max_attempts: 5,
    session_log_enabled: false,
  } as AppSettings;

  function renderSection(overrides: Partial<AppSettings> = {}) {
    const props = {
      applySettings: vi.fn(),
      updateLocalSettings: vi.fn(),
      commitTextSettings: vi.fn(),
    };
    render(<SessionSection form={{ ...form, ...overrides }} {...props} />);
    return props;
  }

  it("toggles auto-reconnect and logging at once", () => {
    const { applySettings } = renderSection();
    fireEvent.click(screen.getByTestId("settings-auto-reconnect"));
    expect(applySettings).toHaveBeenLastCalledWith({ auto_reconnect: false });
    fireEvent.click(screen.getByTestId("settings-session-log-enabled"));
    expect(applySettings).toHaveBeenLastCalledWith({ session_log_enabled: true });
  });

  it("holds typed numbers in range and saves them on blur", () => {
    const { commitTextSettings } = renderSection();
    const keepalive = screen.getByTestId("settings-keepalive-interval");
    fireEvent.change(keepalive, { target: { value: "90000" } });
    expect(commitTextSettings).not.toHaveBeenCalled();
    fireEvent.blur(keepalive);
    expect(commitTextSettings).toHaveBeenLastCalledWith({ keepalive_interval: 3600 });

    const attempts = screen.getByTestId("settings-reconnect-max-attempts");
    fireEvent.change(attempts, { target: { value: "50" } });
    fireEvent.blur(attempts);
    expect(commitTextSettings).toHaveBeenLastCalledWith({ reconnect_max_attempts: 20 });
  });

  it("keeps the value when a number field is left empty", () => {
    const { commitTextSettings } = renderSection();
    const keepalive = screen.getByTestId("settings-keepalive-interval");
    fireEvent.change(keepalive, { target: { value: "" } });
    expect(keepalive).toHaveValue(null);
    fireEvent.blur(keepalive);
    expect(keepalive).toHaveValue(30);
    expect(commitTextSettings).not.toHaveBeenCalled();
  });

  it("keeps the attempts editable with auto-reconnect off, for connections set to on", () => {
    renderSection({ auto_reconnect: false });
    expect(screen.getByTestId("settings-reconnect-max-attempts")).toBeEnabled();
  });

  it("saves a trimmed log folder, and an empty one as unset", () => {
    const { commitTextSettings } = renderSection({ session_log_dir: "/logs" });
    const dir = screen.getByTestId("settings-session-log-dir");
    expect(dir).toHaveValue("/logs");

    fireEvent.blur(dir, { target: { value: "  /var/logs  " } });
    expect(commitTextSettings).toHaveBeenLastCalledWith({ session_log_dir: "/var/logs" });

    fireEvent.blur(dir, { target: { value: "   " } });
    expect(commitTextSettings).toHaveBeenLastCalledWith({ session_log_dir: undefined });
  });
});
