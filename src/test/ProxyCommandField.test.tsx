import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ConnectionForm } from "@/components/ConnectionForm";
import { WSL_PROXY_COMMAND } from "@/lib/platform";
import type { Connection, Credential } from "@/types";
import { chooseSelectValue } from "./radixSelect";

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  credentials: [] as Credential[],
  onSubmit: async () => {},
};

function mockUserAgent(ua: string) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
}

describe("ConnectionForm proxy command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the proxy command of an existing connection", () => {
    const conn: Connection = {
      id: "c1",
      name: "lab",
      host: "10.0.0.5",
      port: 22,
      type: "direct",
      proxy_command: "nc %h %p",
    };
    render(<ConnectionForm {...defaultProps} connection={conn} />);
    expect((screen.getByLabelText(/proxy command/i) as HTMLInputElement).value).toBe("nc %h %p");
  });

  it("offers the Through WSL preset on Windows", () => {
    mockUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    render(<ConnectionForm {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: /through wsl/i }));
    expect((screen.getByLabelText(/proxy command/i) as HTMLInputElement).value).toBe(
      WSL_PROXY_COMMAND,
    );
  });

  it("hides the WSL preset elsewhere", () => {
    mockUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)");
    render(<ConnectionForm {...defaultProps} />);
    expect(screen.queryByRole("button", { name: /through wsl/i })).toBeNull();
  });

  it("saves the trimmed proxy command", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ConnectionForm
        {...defaultProps}
        credentials={[{ id: "c1", name: "default", username: "u", type: "password" }]}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText(/connection name/i), { target: { value: "lab" } });
    fireEvent.change(screen.getByLabelText(/host \*/i), { target: { value: "10.0.0.5" } });
    chooseSelectValue(screen.getByRole("combobox", { name: "Credential" }), "c1");
    fireEvent.change(screen.getByLabelText(/proxy command/i), { target: { value: " nc %h %p " } });
    fireEvent.submit(screen.getByRole("button", { name: /create/i }).closest("form")!);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ proxy_command: "nc %h %p" });
  });
});
