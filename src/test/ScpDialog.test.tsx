import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ScpDialog } from "@/components/ScpDialog";
import { invoke } from "@/lib/tauri";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

describe("ScpDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits upload requests", async () => {
    vi.mocked(invoke).mockResolvedValue({
      local_path: "/tmp/local.txt",
      remote_path: "/srv/app/local.txt",
      bytes: 12,
      entries: 1,
    });

    render(
      <ScpDialog
        open
        onOpenChange={vi.fn()}
        connection={{ id: "c1", name: "prod", host: "host", port: 22, type: "direct", remote_path: "/srv/app" }}
      />
    );

    fireEvent.change(screen.getByLabelText(/local path/i), { target: { value: "/tmp/local.txt" } });
    fireEvent.click(screen.getByRole("button", { name: /upload/i }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("scp_upload", expect.any(Object)));
    expect(await screen.findByText(/Transferred 12 bytes/)).toBeInTheDocument();
  });

  it("passes the recursive option through", async () => {
    vi.mocked(invoke).mockResolvedValue({
      local_path: "/tmp/dir",
      remote_path: "/srv/app/dir",
      bytes: 120,
      entries: 3,
    });

    render(
      <ScpDialog
        open
        onOpenChange={vi.fn()}
        connection={{ id: "c1", name: "prod", host: "host", port: 22, type: "direct", remote_path: "/srv/app" }}
      />
    );

    fireEvent.change(screen.getByLabelText(/local path/i), { target: { value: "/tmp/dir" } });
    fireEvent.click(screen.getByLabelText(/transfer directories recursively/i));
    fireEvent.click(screen.getByRole("button", { name: /upload/i }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "scp_upload",
        expect.objectContaining({
          input: expect.objectContaining({ recursive: true }),
        })
      )
    );
  });
});
