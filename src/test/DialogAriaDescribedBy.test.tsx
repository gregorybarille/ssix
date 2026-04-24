import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConnectionForm } from "@/components/ConnectionForm";
import { CredentialForm } from "@/components/CredentialForm";
import { ScpDialog } from "@/components/ScpDialog";
import { GenerateKeyDialog } from "@/components/GenerateKeyDialog";
import { InstallKeyDialog } from "@/components/InstallKeyDialog";

/*
 * Audit-3 follow-up P1#5: every dialog in SSX must wire a real
 * <DialogDescription> so its aria-describedby points at non-empty
 * descriptive prose. The dialog primitive USED to render an empty
 * sr-only fallback Description to silence Radix's missing-
 * description warning, but that broke the wiring: Radix gives the
 * fallback and the caller-rendered Description the SAME id, and
 * getElementById() returns the FIRST match (the empty fallback) —
 * so screen readers got an empty announcement even when the caller
 * rendered a real description. The fallback was removed; these
 * tests pin that every dialog's content node carries
 * aria-describedby pointing at an element with non-empty text.
 */
function expectDescribed(dialog: HTMLElement) {
  const id = dialog.getAttribute("aria-describedby");
  expect(id, "dialog must have aria-describedby").toBeTruthy();
  const desc = id ? document.getElementById(id) : null;
  expect(desc, `description element ${id} must exist`).not.toBeNull();
  expect(desc!.textContent?.trim().length, "description must be non-empty").toBeGreaterThan(0);
}

describe("Dialog aria-describedby wiring (P1#5)", () => {
  it("ConnectionForm wires a non-empty description", () => {
    render(
      <ConnectionForm open onOpenChange={vi.fn()} credentials={[]} onSubmit={vi.fn()} />,
    );
    expectDescribed(screen.getByRole("dialog"));
  });

  it("CredentialForm wires a non-empty description", () => {
    render(<CredentialForm open onOpenChange={vi.fn()} onSubmit={vi.fn()} />);
    expectDescribed(screen.getByRole("dialog"));
  });

  it("ScpDialog wires a non-empty description", () => {
    render(
      <ScpDialog
        open
        onOpenChange={vi.fn()}
        connection={{
          id: "c1",
          name: "x",
          host: "1.2.3.4",
          port: 22,
          type: "direct",
        }}
        mode="upload"
      />,
    );
    expectDescribed(screen.getByRole("dialog"));
  });

  it("GenerateKeyDialog wires a non-empty description", () => {
    render(<GenerateKeyDialog open onOpenChange={vi.fn()} />);
    expectDescribed(screen.getByRole("dialog"));
  });

  it("InstallKeyDialog wires a non-empty description (visible help text)", () => {
    render(
      <InstallKeyDialog
        open
        onOpenChange={vi.fn()}
        credentialId="c1"
      />,
    );
    expectDescribed(screen.getByRole("dialog"));
    // InstallKeyDialog uses VISIBLE description text (not sr-only)
    // because the security note is important sighted-user context too.
    expect(screen.getByText(/password is\s+not saved/i)).toBeInTheDocument();
  });
});
