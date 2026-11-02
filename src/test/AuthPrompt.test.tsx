import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthPrompt } from "@/components/AuthPrompt";
import { TerminalTabs } from "@/components/TerminalTabs";
import type { AuthPromptRequest } from "@/lib/authPrompt";
import { invoke } from "@/lib/tauri";
import { useAuthPromptStore } from "@/store/useAuthPromptStore";
import { terminalTabsCallbacks } from "./terminalTabsCallbacks";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));
vi.mock("@/components/Terminal", () => ({
  Terminal: ({ sessionId }: { sessionId: string }) => <div data-testid={`terminal-${sessionId}`} />,
}));

const request: AuthPromptRequest = {
  prompt_id: "p1",
  host: "otp.example:22",
  username: "me",
  instructions: "Two questions\nfor you",
  prompts: [
    { text: "Password: ", echo: false },
    { text: "Favourite colour: ", echo: true },
  ],
};

const setup = (overrides: Partial<Parameters<typeof AuthPrompt>[0]> = {}) => {
  const onAnswer = vi.fn(async () => {});
  const onCancel = vi.fn();
  render(
    <AuthPrompt request={request} isVisible onAnswer={onAnswer} onCancel={onCancel} {...overrides} />,
  );
  return { onAnswer, onCancel };
};

const field = (index: number) => screen.getByTestId(`auth-prompt-input-${index}`);

describe("AuthPrompt", () => {
  it("shows who is asking and what, keeping the server's line breaks", () => {
    setup();
    expect(screen.getByText("me@otp.example:22")).toBeInTheDocument();
    expect(screen.getByTestId("auth-prompt-text").textContent).toBe("Two questions\nfor you");
    expect(screen.getByTestId("auth-prompt-text")).toHaveClass("whitespace-pre-wrap");
    expect(screen.getByLabelText("Password:")).toBe(field(0));
    expect(screen.getByLabelText("Favourite colour:")).toBe(field(1));
  });

  it("does not echo a field the server marks hidden, and offers no way to reveal it", () => {
    setup();
    expect(field(0)).toHaveAttribute("type", "password");
    expect(field(0)).toHaveAttribute("autocomplete", "off");
    expect(field(1)).toHaveAttribute("type", "text");
    expect(screen.queryByRole("button", { name: /show password/i })).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Continue", "Cancel"]);
  });

  it("names a field the server left blank", () => {
    setup({ request: { ...request, prompts: [{ text: "", echo: false }] } });
    expect(screen.getByLabelText("Answer 1")).toBe(field(0));
  });

  it("says why it is asking again only during a reconnect", () => {
    setup({ reconnecting: true });
    expect(screen.getByRole("status")).toHaveTextContent("Log in again to reconnect");
  });

  it("says nothing about reconnecting on a first login", () => {
    setup();
    expect(screen.queryByTestId("auth-prompt-reconnecting")).toBeNull();
  });

  it("leaves out empty instructions", () => {
    setup({ request: { ...request, instructions: "" } });
    expect(screen.queryByTestId("auth-prompt-text")).toBeNull();
  });

  it("focuses the first field, also under StrictMode", () => {
    render(
      <StrictMode>
        <AuthPrompt request={request} isVisible onAnswer={vi.fn()} onCancel={vi.fn()} />
      </StrictMode>,
    );
    expect(field(0)).toHaveFocus();
  });

  it("hides with its pane and takes the focus only once visible", () => {
    const props = { request, onAnswer: vi.fn(), onCancel: vi.fn() };
    const { rerender } = render(<AuthPrompt {...props} isVisible={false} />);
    expect(screen.getByTestId("auth-prompt")).toHaveStyle({ display: "none" });
    expect(field(0)).not.toHaveFocus();

    rerender(<AuthPrompt {...props} isVisible />);
    expect(screen.getByTestId("auth-prompt")).toHaveStyle({ display: "flex" });
    expect(field(0)).toHaveFocus();
  });

  it("submits one answer per field in order, then clears them", async () => {
    const { onAnswer } = setup();
    const user = userEvent.setup();
    await user.type(field(0), "hunter2");
    await user.type(field(1), "blue");
    await user.click(screen.getByTestId("auth-prompt-submit"));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(["hunter2", "blue"]));
    await waitFor(() => expect(field(0)).toHaveValue(""));
    expect(field(1)).toHaveValue("");
  });

  it("submits with Enter", async () => {
    const { onAnswer } = setup();
    await userEvent.setup().type(field(0), "hunter2{Enter}");
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(["hunter2", ""]));
  });

  it("accepts empty answers: some servers just want Enter", async () => {
    const { onAnswer } = setup();
    await userEvent.setup().click(screen.getByTestId("auth-prompt-submit"));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(["", ""]));
  });

  it("shows a refusal and clears what was typed", async () => {
    setup({ onAnswer: vi.fn().mockRejectedValue("This prompt is no longer waiting for an answer") });
    const user = userEvent.setup();
    await user.type(field(0), "hunter2");
    await user.click(screen.getByTestId("auth-prompt-submit"));
    const error = await screen.findByTestId("auth-prompt-error");
    expect(error).toHaveTextContent("This prompt is no longer waiting for an answer");
    expect(error).toHaveClass("text-destructive");
    expect(field(0)).toHaveValue("");
  });

  it("never puts an answer in the DOM outside its field", async () => {
    setup();
    await userEvent.setup().type(field(0), "hunter2");
    expect(document.body.textContent).not.toContain("hunter2");
    expect(document.body.innerHTML).not.toContain("hunter2");
  });

  it("cancels without sending anything", async () => {
    const { onAnswer, onCancel } = setup();
    await userEvent.setup().click(screen.getByTestId("auth-prompt-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

describe("a terminal pane with a prompt", () => {
  const onClosePane = vi.fn();
  const connection = { id: "c1", name: "otp", host: "h", port: 22, type: "direct" as const };

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    onClosePane.mockReset();
    useAuthPromptStore.setState({ prompts: {} });
    render(
      <TerminalTabs
        tabs={[
          {
            id: "t1",
            mode: "single",
            panes: [{ sessionId: "pane", connectionName: "otp", connection, retrying: true }],
          },
        ]}
        activeTabId="t1"
        {...terminalTabsCallbacks()}
        onClosePane={onClosePane}
      />,
    );
  });

  const show = () =>
    useAuthPromptStore.getState().receive("pane", { kind: "auth_prompt", ...request });

  it("swaps the connecting view for the prompt and back", async () => {
    expect(screen.getByTestId("failed-terminal")).toBeInTheDocument();
    expect(screen.queryByTestId("auth-prompt")).toBeNull();

    show();
    expect(await screen.findByTestId("auth-prompt")).toBeInTheDocument();
    expect(screen.queryByTestId("failed-terminal")).toBeNull();

    useAuthPromptStore.getState().receive("pane", { kind: "auth_prompt_closed", prompt_id: "p1" });
    expect(await screen.findByTestId("failed-terminal")).toBeInTheDocument();
    expect(screen.queryByTestId("auth-prompt")).toBeNull();
  });

  it("answers through the backend", async () => {
    show();
    const user = userEvent.setup();
    await user.type(await screen.findByTestId("auth-prompt-input-0"), "hunter2");
    await user.click(screen.getByTestId("auth-prompt-submit"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("ssh_auth_answer", {
        promptId: "p1",
        answers: ["hunter2", ""],
      }),
    );
  });

  it("starts each round with empty fields", async () => {
    show();
    const user = userEvent.setup();
    await user.type(await screen.findByTestId("auth-prompt-input-0"), "hunter2");
    useAuthPromptStore
      .getState()
      .receive("pane", { kind: "auth_prompt", ...request, prompt_id: "p2" });
    await waitFor(() => expect(screen.getByTestId("auth-prompt-input-0")).toHaveValue(""));
  });

  it("closes the pane on Cancel", async () => {
    show();
    await userEvent.setup().click(await screen.findByTestId("auth-prompt-cancel"));
    expect(onClosePane).toHaveBeenCalledWith("t1", "pane");
  });
});
