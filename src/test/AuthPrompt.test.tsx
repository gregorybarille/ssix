import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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

  describe("the keyboard", () => {
    /** The prompt in its own pane, next to a field in another. */
    const beside = (isVisible: boolean, onFocusReleased = vi.fn()) => (
      <>
        <input data-testid="elsewhere" />
        <div>
          <AuthPrompt
            request={request}
            isVisible={isVisible}
            onAnswer={vi.fn(async () => {})}
            onCancel={vi.fn()}
            onFocusReleased={onFocusReleased}
          />
        </div>
      </>
    );

    /** A field outside anything rendered, holding the focus. */
    const someoneTyping = () => {
      const input = document.createElement("input");
      document.body.append(input);
      input.focus();
      return input;
    };

    it("takes it when nothing holds it", () => {
      setup();
      expect(field(0)).toHaveFocus();
    });

    it("does not take it from someone typing elsewhere, whose keys stay theirs", async () => {
      const typing = someoneTyping();
      setup();
      expect(typing).toHaveFocus();
      await userEvent.keyboard("hunter2");
      expect(typing.value).toBe("hunter2");
      expect(field(0)).toHaveValue("");
      typing.remove();
    });

    it("takes it from inside its own pane", () => {
      const inPane = document.createElement("input");
      const container = document.createElement("div");
      container.append(inPane);
      document.body.append(container);
      inPane.focus();

      render(
        <AuthPrompt request={request} isVisible onAnswer={vi.fn(async () => {})} onCancel={vi.fn()} />,
        { container },
      );
      expect(field(0)).toHaveFocus();
      cleanup();
      container.remove();
    });

    it("takes it when the user comes to its tab, wherever it was", () => {
      const { rerender } = render(beside(false));
      const elsewhere = screen.getByTestId("elsewhere");
      elsewhere.focus();

      rerender(beside(true));
      expect(field(0)).toHaveFocus();
    });

    it("takes it when the user arrives at a pane whose prompt was already waiting", () => {
      const typing = someoneTyping();
      setup({ userCameToIt: true });
      expect(field(0)).toHaveFocus();
      typing.remove();
    });

    it("leaves it alone while hidden", () => {
      render(beside(false));
      expect(field(0)).not.toHaveFocus();
    });

    it("releases it when the prompt goes, unless someone else has it by then", () => {
      const released = vi.fn();
      const first = render(beside(true, released));
      expect(field(0)).toHaveFocus();
      first.unmount();
      expect(released).toHaveBeenCalledTimes(1);

      const notReleased = vi.fn();
      const second = render(beside(true, notReleased));
      const typing = someoneTyping();
      second.unmount();
      expect(typing).toHaveFocus();
      expect(notReleased).not.toHaveBeenCalled();
      typing.remove();
    });
  });

  it("says what the server refused before asking, only when it did", () => {
    setup();
    expect(screen.queryByTestId("auth-prompt-refused")).toBeNull();
    cleanup();
    setup({ request: { ...request, refused: "The server refused the saved password." } });
    expect(screen.getByTestId("auth-prompt-refused").textContent).toBe(
      "The server refused the saved password.",
    );
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

describe("a prompt out of view", () => {
  const connection = { id: "c1", name: "otp", host: "h", port: 22, type: "direct" as const };
  const tabWith = (id: string, sessionId: string) => ({
    id,
    mode: "single" as const,
    panes: [{ sessionId, connectionName: id, connection, retrying: true }],
  });

  beforeEach(() => useAuthPromptStore.setState({ prompts: {} }));

  it("marks its tab, for as long as it waits and on no other", () => {
    render(
      <TerminalTabs
        tabs={[tabWith("t1", "in-view"), tabWith("t2", "behind")]}
        activeTabId="t1"
        {...terminalTabsCallbacks()}
      />,
    );
    expect(screen.queryByTestId("terminal-tab-prompt-waiting")).toBeNull();

    act(() => useAuthPromptStore.getState().receive("behind", { kind: "auth_prompt", ...request }));
    const tab = screen.getByRole("tab", { name: /login prompt waiting/ });
    expect(tab).toHaveAttribute("id", "terminal-tab-t2");
    expect(screen.getAllByTestId("terminal-tab-prompt-waiting")).toHaveLength(1);

    act(() =>
      useAuthPromptStore.getState().receive("behind", { kind: "auth_prompt_closed", prompt_id: "p1" }),
    );
    expect(screen.queryByTestId("terminal-tab-prompt-waiting")).toBeNull();
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
