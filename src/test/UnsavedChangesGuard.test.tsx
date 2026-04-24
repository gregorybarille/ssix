import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CredentialForm } from "@/components/CredentialForm";
import { ConnectionForm } from "@/components/ConnectionForm";

beforeEach(() => {
  cleanup();
});

describe("Unsaved-changes guard — CredentialForm", () => {
  it("closes silently when no fields have been edited", () => {
    const onOpenChange = vi.fn();
    render(
      <CredentialForm
        open
        onOpenChange={onOpenChange}
        credential={null}
        onSubmit={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // No Discard prompt should have appeared.
    expect(
      screen.queryByRole("dialog", { name: /discard unsaved changes/i }),
    ).not.toBeInTheDocument();
  });

  it("prompts before closing when the user has typed something", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <CredentialForm
        open
        onOpenChange={onOpenChange}
        credential={null}
        onSubmit={vi.fn()}
      />,
    );
    // Wait for the baseline snapshot to settle (queued via setTimeout(0)).
    await waitFor(() => {
      expect(
        screen.getByLabelText(/credential name/i),
      ).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText(/credential name/i), "prod");
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    // Discard dialog appears; original close did NOT fire yet.
    await screen.findByRole("dialog", { name: /discard unsaved changes/i });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("'Keep editing' dismisses the prompt and keeps the form open", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <CredentialForm
        open
        onOpenChange={onOpenChange}
        credential={null}
        onSubmit={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/credential name/i)).toBeInTheDocument(),
    );
    await user.type(screen.getByLabelText(/credential name/i), "x");
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await screen.findByRole("dialog", { name: /discard unsaved changes/i });
    fireEvent.click(screen.getByRole("button", { name: /keep editing/i }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: /discard unsaved changes/i }),
      ).not.toBeInTheDocument();
    });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("'Discard' confirms and closes the form", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <CredentialForm
        open
        onOpenChange={onOpenChange}
        credential={null}
        onSubmit={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/credential name/i)).toBeInTheDocument(),
    );
    await user.type(screen.getByLabelText(/credential name/i), "x");
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await screen.findByRole("dialog", { name: /discard unsaved changes/i });
    fireEvent.click(screen.getByRole("button", { name: /^discard$/i }));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("does NOT prompt after a successful save (markSaved suppresses the next close)", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(
      <CredentialForm
        open
        onOpenChange={onOpenChange}
        credential={null}
        onSubmit={onSubmit}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/credential name/i)).toBeInTheDocument(),
    );
    await user.type(screen.getByLabelText(/credential name/i), "prod");
    await user.type(screen.getByLabelText(/^username/i), "alice");
    await user.type(
      screen.getByLabelText(/^password$/i, { selector: "input" }),
      "hunter2",
    );
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(
      screen.queryByRole("dialog", { name: /discard unsaved changes/i }),
    ).not.toBeInTheDocument();
  });
});

describe("Unsaved-changes guard — ConnectionForm", () => {
  it("closes silently when no fields have been edited", () => {
    const onOpenChange = vi.fn();
    render(
      <ConnectionForm
        open
        onOpenChange={onOpenChange}
        credentials={[]}
        onSubmit={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("prompts before closing when the connection name has been edited", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ConnectionForm
        open
        onOpenChange={onOpenChange}
        credentials={[]}
        onSubmit={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/connection name/i)).toBeInTheDocument(),
    );
    await user.type(screen.getByLabelText(/connection name/i), "web");
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await screen.findByRole("dialog", { name: /discard unsaved changes/i });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
