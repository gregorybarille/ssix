import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FailedTerminal } from "@/components/FailedTerminal";
import { Connection } from "@/types";

const conn: Connection = {
  id: "c1",
  name: "prod",
  host: "10.0.0.1",
  port: 22,
  type: "direct",
};

describe("FailedTerminal", () => {
  /*
   * Audit-3 P3#15: connection failures must be announced to screen
   * readers. The whole status block (heading + backend's error
   * string) is wrapped in role=alert + aria-live=assertive when
   * `error` is set, so AT announces it as soon as the FailedTerminal
   * mounts or the error changes between retries.
   */
  it("error state exposes role=alert + aria-live=assertive", () => {
    render(
      <FailedTerminal
        connectionName="prod"
        error="connection refused"
        connection={conn}
        isVisible
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(alert.textContent).toMatch(/Could not connect to prod/);
    expect(alert.textContent).toMatch(/connection refused/);
  });

  /*
   * Connecting state must NOT be assertive — it's an in-progress
   * status, not an emergency. Use role=status + aria-live=polite so
   * AT informs the user without interrupting their current speech.
   */
  it("connecting state uses role=status + aria-live=polite", () => {
    render(
      <FailedTerminal
        connectionName="prod"
        connection={conn}
        isVisible
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status.textContent).toMatch(/Connecting to prod/);
  });

  it("AlertCircle decoration is aria-hidden", () => {
    const { container } = render(
      <FailedTerminal
        connectionName="prod"
        error="boom"
        connection={conn}
        isVisible
        onRetry={vi.fn()}
        onEdit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // AlertCircle renders an SVG; it should be aria-hidden so AT
    // doesn't double-announce ("warning Could not connect to prod").
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });
});
