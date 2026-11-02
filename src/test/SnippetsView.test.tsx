import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { SnippetsView } from "@/components/views/SnippetsView";
import { invoke } from "@/lib/tauri";
import { useSnippetsStore } from "@/store/useSnippetsStore";
import { useViewStore } from "@/store/useViewStore";
import type { Snippet, SnippetInput } from "@/types";
import { renderInPanel } from "./panel";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));

const mockInvoke = vi.mocked(invoke);

const tail: Snippet = { id: "s1", name: "tail", command: "tail -f {{file}}", tags: ["logs"] };
const disk: Snippet = { id: "s2", name: "disk", command: "df -h" };

function respond(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    const handler = handlers[cmd];
    return handler ? handler(args ?? {}) : [];
  });
}

async function renderView(snippets: Snippet[]) {
  respond({ get_snippets: () => snippets });
  renderInPanel(<SnippetsView />);
  if (snippets.length > 0) await screen.findByTestId("snippet-list");
  else await screen.findByText("No snippets yet");
}

const row = (name: string) =>
  document.querySelector<HTMLElement>(`[data-testid="snippet-row"][data-name="${name}"]`);
const fill = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe("SnippetsView", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    useSnippetsStore.setState({ snippets: [], error: null, isLoading: false, paletteOpen: false });
    useViewStore.setState({ view: "snippets", leaveGuard: null });
  });

  it("lists name, command and tags", async () => {
    await renderView([tail, disk]);
    const first = within(row("tail")!);
    expect(first.getByText("tail -f {{file}}")).toBeInTheDocument();
    expect(first.getByText("logs")).toBeInTheDocument();
    expect(row("disk")).toBeInTheDocument();
  });

  it("says how to paste, whatever the list holds", async () => {
    await renderView([]);
    expect(screen.getByText(/Shift\+S pastes one into the active terminal/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing runs until you press Enter/)).toBeInTheDocument();
  });

  it("shows a load failure with a retry instead of an empty list alone", async () => {
    mockInvoke.mockRejectedValueOnce("disk on fire");
    renderInPanel(<SnippetsView />);
    expect(await screen.findByTestId("snippets-load-error")).toHaveTextContent("disk on fire");
    mockInvoke.mockResolvedValueOnce([disk]);
    fireEvent.click(screen.getByTestId("snippets-load-error-retry"));
    await waitFor(() => expect(row("disk")).toBeInTheDocument());
    expect(screen.queryByTestId("snippets-load-error")).not.toBeInTheDocument();
  });

  it("opens the palette from the Paste button", async () => {
    await renderView([disk]);
    fireEvent.click(screen.getByTestId("snippet-palette-button"));
    expect(useSnippetsStore.getState().paletteOpen).toBe(true);
  });

  it("names the icon buttons after their snippet", async () => {
    await renderView([disk]);
    expect(screen.getByRole("button", { name: "Edit disk" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete disk" })).toBeInTheDocument();
  });

  describe("the form", () => {
    it("opens in the side panel, focused on the name", async () => {
      await renderView([]);
      fireEvent.click(screen.getByTestId("add-snippet-button"));
      const form = await screen.findByTestId("snippet-form");
      expect(screen.getByTestId("app-panel-slot")).toContainElement(form);
      expect(screen.getByTestId("snippet-form-name")).toHaveFocus();
      expect(screen.getByText("New Snippet", { selector: "h2" })).toBeInTheDocument();
    });

    it("warns that Git Sync exports snippets as written", async () => {
      await renderView([]);
      fireEvent.click(screen.getByTestId("add-snippet-button"));
      const notice = await screen.findByTestId("snippet-form-git-sync-notice");
      expect(notice).toHaveTextContent("Git Sync exports snippets exactly as written");
      expect(notice).toHaveTextContent("Keep passwords and tokens out");
    });

    it("lists the variables it found as the command is typed", async () => {
      await renderView([]);
      fireEvent.click(screen.getByTestId("add-snippet-button"));
      await screen.findByTestId("snippet-form");
      expect(screen.queryByTestId("snippet-form-variables")).not.toBeInTheDocument();
      fill("snippet-form-command", "scp {{file}} {{host}}:{{file}} '{{.Names}}'");
      expect(screen.getByTestId("snippet-form-variables")).toHaveTextContent(
        "Asks for: file, host",
      );
    });

    it("creates a snippet and adds it to the list", async () => {
      const add = vi.fn(({ input }: Record<string, unknown>) => ({
        id: "new",
        ...(input as SnippetInput),
      }));
      await renderView([]);
      respond({ add_snippet: add });
      fireEvent.click(screen.getByTestId("add-snippet-button"));
      await screen.findByTestId("snippet-form");
      fill("snippet-form-name", "disk");
      fill("snippet-form-command", "df -h\n");
      fireEvent.submit(screen.getByTestId("snippet-form"));
      await waitFor(() => expect(row("disk")).toBeInTheDocument());
      expect(add.mock.calls[0][0]).toEqual({
        input: { name: "disk", command: "df -h\n", tags: [] },
      });
      expect(screen.queryByTestId("snippet-form")).not.toBeInTheDocument();
    });

    it("sends tags to the backend", async () => {
      const add = vi.fn(({ input }: Record<string, unknown>) => ({
        id: "new",
        ...(input as SnippetInput),
      }));
      await renderView([]);
      respond({ add_snippet: add });
      fireEvent.click(screen.getByTestId("add-snippet-button"));
      await screen.findByTestId("snippet-form");
      fill("snippet-form-name", "disk");
      fill("snippet-form-command", "df -h");
      const tags = screen.getByLabelText("Tags");
      fireEvent.change(tags, { target: { value: "ops" } });
      fireEvent.keyDown(tags, { key: "Enter" });
      fireEvent.submit(screen.getByTestId("snippet-form"));
      await waitFor(() => expect(add).toHaveBeenCalled());
      expect(add.mock.calls[0][0]).toEqual({
        input: { name: "disk", command: "df -h", tags: ["ops"] },
      });
    });

    it("keeps required fields inline and calls nothing", async () => {
      await renderView([]);
      respond({ add_snippet: () => { throw new Error("must not be called"); } });
      fireEvent.click(screen.getByTestId("add-snippet-button"));
      await screen.findByTestId("snippet-form");
      fill("snippet-form-name", "  ");
      fill("snippet-form-command", " \n ");
      fireEvent.submit(screen.getByTestId("snippet-form"));
      expect(await screen.findByText("Name is required")).toBeInTheDocument();
      expect(screen.getByText("Command is required")).toBeInTheDocument();
      expect(screen.getByTestId("snippet-form-name")).toHaveAttribute("aria-invalid", "true");
      expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "add_snippet")).toBe(false);
    });

    it("keeps the form open with the backend's reason, and the fields", async () => {
      await renderView([disk]);
      respond({
        add_snippet: () => {
          throw 'A snippet named "disk" already exists';
        },
      });
      fireEvent.click(screen.getByTestId("add-snippet-button"));
      await screen.findByTestId("snippet-form");
      fill("snippet-form-name", "disk");
      fill("snippet-form-command", "df");
      fireEvent.submit(screen.getByTestId("snippet-form"));
      expect(await screen.findByTestId("snippet-form-error")).toHaveTextContent("already exists");
      expect(screen.getByTestId("snippet-form-name")).toHaveValue("disk");
      expect(useSnippetsStore.getState().error).toBeNull();
    });

    it("edits a snippet in place", async () => {
      const update = vi.fn(({ id, input }: Record<string, unknown>) => ({
        id,
        ...(input as SnippetInput),
      }));
      await renderView([tail, disk]);
      respond({ update_snippet: update });
      fireEvent.click(screen.getByRole("button", { name: "Edit tail" }));
      await screen.findByTestId("snippet-form");
      expect(screen.getByText("Edit Snippet")).toBeInTheDocument();
      expect(screen.getByTestId("snippet-form-command")).toHaveValue("tail -f {{file}}");
      expect(screen.getByRole("list", { name: "Tags" })).toHaveTextContent("logs");
      fill("snippet-form-command", "tail -n 50 {{file}}");
      fireEvent.submit(screen.getByTestId("snippet-form"));
      await waitFor(() =>
        expect(within(row("tail")!).getByText("tail -n 50 {{file}}")).toBeInTheDocument(),
      );
      expect(update.mock.calls[0][0]).toEqual({
        id: "s1",
        input: { name: "tail", command: "tail -n 50 {{file}}", tags: ["logs"] },
      });
    });
  });

  describe("unsaved changes", () => {
    it("closes a clean form at once", async () => {
      await renderView([disk]);
      fireEvent.click(screen.getByTestId("add-snippet-button"));
      await screen.findByTestId("snippet-form");
      fireEvent.click(screen.getByTestId("snippet-form-cancel"));
      expect(screen.queryByTestId("snippet-form")).not.toBeInTheDocument();
    });

    it("asks before discarding, and keeps the edit on Keep editing", async () => {
      await renderView([disk]);
      fireEvent.click(screen.getByTestId("add-snippet-button"));
      await screen.findByTestId("snippet-form");
      fill("snippet-form-name", "draft");
      fireEvent.click(screen.getByTestId("snippet-form-cancel"));
      fireEvent.click(await screen.findByTestId("snippet-discard-cancel"));
      expect(screen.getByTestId("snippet-form-name")).toHaveValue("draft");
      fireEvent.click(screen.getByTestId("snippet-form-cancel"));
      fireEvent.click(await screen.findByTestId("snippet-discard-confirm"));
      await waitFor(() => expect(screen.queryByTestId("snippet-form")).not.toBeInTheDocument());
    });

    it("counts a changed tag list as unsaved", async () => {
      await renderView([tail]);
      fireEvent.click(screen.getByRole("button", { name: "Edit tail" }));
      await screen.findByTestId("snippet-form");
      fireEvent.click(screen.getByRole("button", { name: "Remove tag logs" }));
      fireEvent.click(screen.getByTestId("snippet-form-cancel"));
      expect(await screen.findByTestId("snippet-discard")).toBeInTheDocument();
    });

    it("asks before another row replaces a dirty form", async () => {
      await renderView([tail, disk]);
      fireEvent.click(screen.getByRole("button", { name: "Edit tail" }));
      await screen.findByTestId("snippet-form");
      fill("snippet-form-name", "changed");
      fireEvent.click(screen.getByRole("button", { name: "Edit disk" }));
      fireEvent.click(await screen.findByTestId("snippet-discard-confirm"));
      await waitFor(() => expect(screen.getByTestId("snippet-form-name")).toHaveValue("disk"));
    });

    it("asks before leaving the view with a dirty form", async () => {
      await renderView([disk]);
      fireEvent.click(screen.getByTestId("add-snippet-button"));
      await screen.findByTestId("snippet-form");
      fill("snippet-form-name", "draft");
      act(() => useViewStore.getState().setView("connections"));
      expect(useViewStore.getState().view).toBe("snippets");
      fireEvent.click(await screen.findByTestId("snippet-discard-confirm"));
      await waitFor(() => expect(useViewStore.getState().view).toBe("connections"));
    });
  });

  describe("deleting", () => {
    it("goes through a confirmation", async () => {
      await renderView([tail, disk]);
      respond({ delete_snippet: () => undefined });
      fireEvent.click(screen.getByRole("button", { name: "Delete tail" }));
      const dialog = await screen.findByTestId("snippet-delete-dialog");
      expect(dialog).toHaveTextContent("tail");
      expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "delete_snippet")).toBe(false);
      fireEvent.click(screen.getByTestId("snippet-delete-dialog-confirm"));
      await waitFor(() => expect(row("tail")).toBeNull());
      expect(row("disk")).toBeInTheDocument();
      expect(mockInvoke).toHaveBeenCalledWith("delete_snippet", { id: "s1" });
    });

    it("leaves the row alone on cancel", async () => {
      await renderView([tail]);
      fireEvent.click(screen.getByRole("button", { name: "Delete tail" }));
      fireEvent.click(await screen.findByTestId("snippet-delete-dialog-cancel"));
      await waitFor(() =>
        expect(screen.queryByTestId("snippet-delete-dialog")).not.toBeInTheDocument(),
      );
      expect(row("tail")).toBeInTheDocument();
    });

    it("closes the editor of the snippet it deleted", async () => {
      await renderView([tail]);
      respond({ delete_snippet: () => undefined });
      fireEvent.click(screen.getByRole("button", { name: "Edit tail" }));
      await screen.findByTestId("snippet-form");
      fireEvent.click(screen.getByRole("button", { name: "Delete tail" }));
      fireEvent.click(await screen.findByTestId("snippet-delete-dialog-confirm"));
      await waitFor(() => expect(screen.queryByTestId("snippet-form")).not.toBeInTheDocument());
    });

    it("shows a failed delete in the confirmation and keeps the row", async () => {
      await renderView([tail]);
      respond({
        delete_snippet: () => {
          throw "disk full";
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "Delete tail" }));
      fireEvent.click(await screen.findByTestId("snippet-delete-dialog-confirm"));
      expect(await screen.findByTestId("snippet-delete-dialog-error")).toHaveTextContent(
        "disk full",
      );
      expect(row("tail")).toBeInTheDocument();
    });
  });
});
