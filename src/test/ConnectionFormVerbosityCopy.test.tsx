import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConnectionForm } from "@/components/ConnectionForm";

/**
 * P2-31: the verbosity dropdown previously labeled the highest level
 * "2 — Debug (libssh2 trace)" and the helper text mentioned
 * "low-level libssh2 tracing". Surfacing the underlying library name
 * is meaningless to most users and creates churn if the SSH backend
 * is ever swapped. This test locks in the user-friendly copy.
 */
describe("ConnectionForm verbosity copy", () => {
  it("does not expose the libssh2 library name to users", () => {
    render(
      <ConnectionForm
        open
        onOpenChange={vi.fn()}
        credentials={[]}
        onSubmit={vi.fn()}
      />,
    );
    // The label text appears in the trigger and inside the open menu.
    // Neither user-facing surface should mention libssh2.
    expect(screen.queryByText(/libssh2/i)).toBeNull();
  });

  it("describes level 2 as a full SSH protocol trace", () => {
    render(
      <ConnectionForm
        open
        onOpenChange={vi.fn()}
        credentials={[]}
        onSubmit={vi.fn()}
      />,
    );
    // The helper paragraph and dropdown items should both still
    // communicate that level 2 is verbose / for diagnostics.
    expect(
      screen.getByText(
        /low-level SSH protocol trace/i,
      ),
    ).toBeInTheDocument();
  });
});
