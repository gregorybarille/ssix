import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CredentialForm } from "@/components/CredentialForm";

vi.mock("@/lib/dialog", () => ({
  pickFile: vi.fn(),
}));

import { pickFile } from "@/lib/dialog";

describe("CredentialForm Browse private key button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the file picker and writes the chosen path into the input", async () => {
    (pickFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/Users/me/.ssh/id_ed25519",
    );
    const user = userEvent.setup();
    render(
      <CredentialForm open onOpenChange={() => {}} onSubmit={vi.fn()} />,
    );
    await user.click(screen.getByRole("tab", { name: /ssh key/i }));
    const browse = await screen.findByRole("button", {
      name: /browse for private key file/i,
    });
    await user.click(browse);
    await waitFor(() => {
      expect(pickFile).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Select SSH private key",
          filters: [{ name: "All files", extensions: ["*"] }],
        }),
      );
    });
    const input = screen.getByLabelText(/private key path/i) as HTMLInputElement;
    await waitFor(() =>
      expect(input.value).toBe("/Users/me/.ssh/id_ed25519"),
    );
  });

  it("leaves the input untouched when the user cancels the picker", async () => {
    (pickFile as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const user = userEvent.setup();
    render(
      <CredentialForm open onOpenChange={() => {}} onSubmit={vi.fn()} />,
    );
    await user.click(screen.getByRole("tab", { name: /ssh key/i }));
    const input = screen.getByLabelText(/private key path/i) as HTMLInputElement;
    await user.type(input, "/preexisting");
    await user.click(
      screen.getByRole("button", { name: /browse for private key file/i }),
    );
    await waitFor(() => expect(pickFile).toHaveBeenCalled());
    expect(input.value).toBe("/preexisting");
  });

  it("clears the inline 'Private key path is required' error after a pick", async () => {
    (pickFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/Users/me/.ssh/id_ed25519",
    );
    const user = userEvent.setup();
    render(
      <CredentialForm open onOpenChange={() => {}} onSubmit={vi.fn()} />,
    );
    await user.type(screen.getByLabelText(/credential name/i), "n");
    await user.type(screen.getByLabelText(/^username/i), "u");
    await user.click(screen.getByRole("tab", { name: /ssh key/i }));
    // Trigger validation while the path is empty.
    await user.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/private key path is required/i),
      ).toBeInTheDocument(),
    );
    // Pick a file — the inline error should disappear.
    await user.click(
      screen.getByRole("button", { name: /browse for private key file/i }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText(/private key path is required/i),
      ).not.toBeInTheDocument(),
    );
  });
});
