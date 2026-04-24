import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConnectionForm } from "@/components/ConnectionForm";
import { CredentialForm } from "@/components/CredentialForm";

describe("Form sticky footer layout", () => {
  it("ConnectionForm renders the action buttons outside the scrollable body", () => {
    render(
      <ConnectionForm
        open
        onOpenChange={vi.fn()}
        credentials={[]}
        onSubmit={vi.fn()}
      />,
    );
    const submit = screen.getByRole("button", { name: /create/i });
    // The closest scrollable ancestor of the form fields should NOT contain
    // the submit/cancel buttons. The footer must live outside the scroll
    // container so Save/Cancel stay visible while the body scrolls.
    const footer = submit.parentElement!;
    const scrollContainer = footer.parentElement!.querySelector(
      ".overflow-y-auto",
    );
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer!.contains(submit)).toBe(false);
  });

  it("CredentialForm renders the action buttons outside the scrollable body", () => {
    render(
      <CredentialForm open onOpenChange={vi.fn()} onSubmit={vi.fn()} />,
    );
    const submit = screen.getByRole("button", { name: /create/i });
    const footer = submit.parentElement!;
    const scrollContainer = footer.parentElement!.querySelector(
      ".overflow-y-auto",
    );
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer!.contains(submit)).toBe(false);
  });
});
