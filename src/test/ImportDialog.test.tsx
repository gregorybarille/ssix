/**
 * The import panel: a preview before anything is written, rows the user can
 * untick, skips with their reasons, and a confirm that sends only what stays
 * ticked. The mapping itself is tested in `commands/import_config.rs`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportButton, ImportDialog } from "@/components/ImportDialog";
import { ConnectionsView } from "@/components/views/ConnectionsView";
import { invoke } from "@/lib/tauri";
import { pickFile } from "@/lib/dialog";
import { useConnectionsStore } from "@/store/useConnectionsStore";
import { useCredentialsStore } from "@/store/useCredentialsStore";
import { useImportStore } from "@/store/useImportStore";
import { renderInPanel } from "./panel";
import type { AppSettings, ImportItem, ImportPreview, ImportResult } from "@/types";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/dialog", () => ({ pickFile: vi.fn() }));

const item = (name: string, overrides: Partial<ImportItem> = {}): ImportItem => ({
  key: `key-${name}`,
  name,
  type: "direct",
  target: `deploy@${name}:22`,
  credentials: [
    {
      role: "Credential",
      name: "deploy@id",
      username: "deploy",
      private_key_path: "/home/u/.ssh/id",
      exists: false,
    },
  ],
  proxy_command: null,
  notes: [],
  source: "~/.ssh/config:1",
  preselected: true,
  ...overrides,
});

const PREVIEW: ImportPreview = {
  path: "~/.ssh/config",
  files: ["~/.ssh/config", "~/.ssh/extra"],
  items: [
    item("web"),
    item("jumped", {
      type: "jump_shell",
      target: "app@10.0.0.9:22 through ops@bastion:22",
      credentials: [
        {
          role: "Jump host credential",
          name: "ops (agent)",
          username: "ops",
          private_key_path: null,
          exists: true,
        },
        {
          role: "Target credential",
          name: "deploy@id",
          username: "app",
          private_key_path: "/home/u/.ssh/id",
          exists: false,
        },
      ],
      notes: ["The config sets no User: signs in as me, your login name, as ssh does"],
    }),
    item("proxied", { proxy_command: "nc -X connect %h %p" }),
  ],
  skipped: [
    { name: "*", category: "pattern", reason: "Supplies defaults", source: "~/.ssh/config:9" },
    {
      name: "clash",
      category: "name_clash",
      reason: "A connection named 'clash' already exists with another destination",
      source: "~/.ssh/config:5",
    },
    { name: "two", category: "unsupported", reason: "2 hops", source: "~/.ssh/config:6" },
  ],
  notices: [{ message: "Match block skipped", source: "~/.ssh/config:7" }],
};

const RESULT: ImportResult = { connections: ["web"], credentials: ["deploy@id"] };

type Handler = (args: unknown) => unknown;

/** Answer each command with `handlers[command]`, recording every call. */
function mockBackend(handlers: Record<string, Handler>) {
  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
    const handler = handlers[command];
    if (!handler) throw new Error(`Unexpected command ${command}`);
    return handler(args) as never;
  });
}

function backendWith(preview: ImportPreview = PREVIEW) {
  mockBackend({
    import_ssh_config_preview: () => preview,
    import_ssh_config_apply: () => RESULT,
    get_connections: () => [],
    get_credentials: () => [],
  });
}

const calls = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

function renderDialog() {
  const onOpenChange = vi.fn();
  renderInPanel(<ImportDialog open onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

const row = (name: string) =>
  screen.getAllByTestId("import-item").find((el) => el.getAttribute("data-name") === name)!;

const checkbox = (name: string) => within(row(name)).getByRole("checkbox");

async function renderLoaded() {
  const rendered = renderDialog();
  await screen.findAllByTestId("import-item");
  return rendered;
}

describe("ImportDialog", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(pickFile).mockReset();
    useImportStore.setState({ preview: null, isLoading: false, error: null });
  });

  it("reads ~/.ssh/config on opening and writes nothing", async () => {
    backendWith();
    await renderLoaded();
    expect(calls("import_ssh_config_preview")).toEqual([
      ["import_ssh_config_preview", { path: "~/.ssh/config" }],
    ]);
    expect(calls("import_ssh_config_apply")).toEqual([]);
  });

  it("shows what will be created with its kind, target and credentials", async () => {
    backendWith();
    await renderLoaded();
    const jumped = within(row("jumped"));
    expect(jumped.getByText("Jump host")).toBeInTheDocument();
    expect(jumped.getByText("app@10.0.0.9:22 through ops@bastion:22")).toBeInTheDocument();
    expect(
      jumped.getByText("Jump host credential: ops (agent) (existing), keys from the SSH agent"),
    ).toBeInTheDocument();
    expect(
      jumped.getByText("Target credential: deploy@id (new), /home/u/.ssh/id"),
    ).toBeInTheDocument();
    expect(jumped.getByText(/signs in as me/)).toBeInTheDocument();
    expect(screen.getByTestId("import-files")).toHaveTextContent("~/.ssh/extra");
  });

  it("shows a proxy command in full, since it would run on connect", async () => {
    backendWith();
    await renderLoaded();
    const proxied = within(row("proxied"));
    expect(proxied.getByText(/Runs this local command/)).toBeInTheDocument();
    expect(proxied.getByText("nc -X connect %h %p")).toBeInTheDocument();
  });

  it("lists every skip with its reason, name clashes first, and offers no tick for them", async () => {
    backendWith();
    await renderLoaded();
    const skips = screen.getAllByTestId("import-skip");
    expect(skips.map((el) => el.getAttribute("data-name"))).toEqual(["clash", "two", "*"]);
    expect(skips[0]).toHaveTextContent("Name clash");
    expect(skips[0]).toHaveTextContent("already exists with another destination");
    expect(skips[1]).toHaveTextContent("2 hops");
    expect(skips[2]).toHaveTextContent("Supplies defaults");
    for (const skip of skips) {
      expect(within(skip).queryByRole("checkbox")).toBeNull();
    }
    expect(screen.getByTestId("import-notice")).toHaveTextContent("Match block skipped");
  });

  it("starts with every row ticked and imports only what stays ticked", async () => {
    const user = userEvent.setup();
    backendWith();
    await renderLoaded();
    expect(checkbox("web")).toBeChecked();
    expect(checkbox("jumped")).toBeChecked();

    await user.click(checkbox("jumped"));
    const confirm = screen.getByTestId("import-confirm");
    expect(confirm).toHaveTextContent("Import 2 connections");
    await user.click(confirm);

    await screen.findByTestId("import-result");
    expect(calls("import_ssh_config_apply")).toEqual([
      [
        "import_ssh_config_apply",
        { input: { path: "~/.ssh/config", keys: ["key-web", "key-proxied"] } },
      ],
    ]);
  });

  it("leaves a row unticked when the backend says so, and lets it be chosen", async () => {
    const user = userEvent.setup();
    backendWith({
      ...PREVIEW,
      items: [
        item("prod"),
        item("prod-alt", {
          preselected: false,
          notes: ["Same destination as 'prod', so it starts unticked."],
        }),
      ],
    });
    await renderLoaded();
    expect(checkbox("prod")).toBeChecked();
    expect(checkbox("prod-alt")).not.toBeChecked();
    expect(within(row("prod-alt")).getByText(/Same destination/)).toBeInTheDocument();
    expect(screen.getByTestId("import-select-all")).toHaveAttribute("aria-checked", "mixed");
    expect(screen.getByTestId("import-confirm")).toHaveTextContent("Import 1 connection");

    await user.click(checkbox("prod"));
    await user.click(checkbox("prod-alt"));
    await user.click(screen.getByTestId("import-confirm"));

    await screen.findByTestId("import-result");
    expect(calls("import_ssh_config_apply")).toEqual([
      ["import_ssh_config_apply", { input: { path: "~/.ssh/config", keys: ["key-prod-alt"] } }],
    ]);
  });

  it("offers nothing by default when every row is held back, but lets each be ticked", async () => {
    const user = userEvent.setup();
    const note = "Part of this config was not applied (see Passed over)";
    backendWith({
      ...PREVIEW,
      items: [
        item("web", { preselected: false, notes: [note] }),
        item("db", { preselected: false, notes: [note] }),
      ],
    });
    await renderLoaded();
    expect(checkbox("web")).not.toBeChecked();
    expect(checkbox("db")).not.toBeChecked();
    expect(within(row("web")).getByText(note)).toBeInTheDocument();
    expect(within(row("db")).getByText(note)).toBeInTheDocument();
    expect(screen.getByTestId("import-select-all")).not.toBeChecked();
    expect(screen.getByTestId("import-confirm")).toBeDisabled();

    await user.click(checkbox("db"));
    await user.click(screen.getByTestId("import-confirm"));
    await screen.findByTestId("import-result");
    expect(calls("import_ssh_config_apply")).toEqual([
      ["import_ssh_config_apply", { input: { path: "~/.ssh/config", keys: ["key-db"] } }],
    ]);
  });

  it("keeps what the user ticked when the preview is read again", async () => {
    const user = userEvent.setup();
    backendWith({ ...PREVIEW, items: [item("web"), item("alt", { preselected: false })] });
    await renderLoaded();
    await user.click(checkbox("web"));
    await user.click(checkbox("alt"));

    await user.click(screen.getByTestId("import-load"));
    await waitFor(() => expect(calls("import_ssh_config_preview")).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("import-load")).toBeEnabled());
    expect(checkbox("web")).not.toBeChecked();
    expect(checkbox("alt")).toBeChecked();
  });

  it("toggles every row at once", async () => {
    const user = userEvent.setup();
    backendWith();
    await renderLoaded();
    const all = screen.getByTestId("import-select-all");
    expect(all).toBeChecked();

    await user.click(all);
    expect(checkbox("web")).not.toBeChecked();
    expect(screen.getByTestId("import-confirm")).toBeDisabled();

    await user.click(checkbox("web"));
    expect(all).toHaveAttribute("aria-checked", "mixed");
    expect(screen.getByTestId("import-confirm")).toHaveTextContent("Import 1 connection");

    await user.click(all);
    expect(checkbox("jumped")).toBeChecked();
  });

  it("after importing, refreshes the lists, reports it and reads the file again", async () => {
    const user = userEvent.setup();
    backendWith();
    await renderLoaded();
    await user.click(screen.getByTestId("import-confirm"));

    const status = await screen.findByTestId("import-result");
    expect(status).toHaveTextContent("Imported 1 connection and 1 credential.");
    expect(status).toHaveAttribute("role", "status");
    expect(calls("get_connections")).toHaveLength(1);
    expect(calls("get_credentials")).toHaveLength(1);
    await waitFor(() => expect(calls("import_ssh_config_preview")).toHaveLength(2));
    expect(screen.getByTestId("import-close")).toHaveTextContent("Done");
  });

  it("closing without confirming sends nothing", async () => {
    const user = userEvent.setup();
    backendWith();
    const { onOpenChange } = await renderLoaded();
    await user.click(screen.getByTestId("import-close"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(calls("import_ssh_config_apply")).toEqual([]);
  });

  it("has nothing to confirm when every host was skipped", async () => {
    backendWith({ ...PREVIEW, items: [] });
    renderDialog();
    await screen.findByTestId("import-nothing");
    expect(screen.getByTestId("import-confirm")).toBeDisabled();
    expect(screen.queryByTestId("import-select-all")).toBeNull();
  });

  it("reports a file it cannot read and offers a retry", async () => {
    const user = userEvent.setup();
    mockBackend({
      import_ssh_config_preview: () => {
        throw "~/.ssh/config does not exist";
      },
    });
    renderDialog();
    const banner = await screen.findByTestId("import-load-error");
    expect(banner).toHaveTextContent("~/.ssh/config does not exist");
    expect(screen.getByTestId("import-confirm")).toBeDisabled();

    backendWith();
    await user.click(screen.getByTestId("import-load-error-retry"));
    await screen.findAllByTestId("import-item");
    expect(screen.queryByTestId("import-load-error")).toBeNull();
  });

  it("keeps the panel open when the import is refused and shows the fresh preview", async () => {
    const user = userEvent.setup();
    const changed = { ...PREVIEW, items: [item("web", { key: "key-changed", target: "changed" })] };
    let previews = 0;
    mockBackend({
      import_ssh_config_preview: () => (previews++ === 0 ? PREVIEW : changed),
      import_ssh_config_apply: () => {
        throw "The config changed since this preview.";
      },
    });
    const { onOpenChange } = await renderLoaded();
    await user.click(screen.getByTestId("import-confirm"));

    const banner = await screen.findByTestId("import-apply-error");
    expect(banner).toHaveTextContent("changed since this preview");
    await screen.findByText("changed");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("import-result")).toBeNull();
  });

  it("reads another file on request and imports from the one on screen", async () => {
    const user = userEvent.setup();
    const other = { ...PREVIEW, path: "/work/config" };
    mockBackend({
      import_ssh_config_preview: (args) =>
        (args as { path: string }).path === "/work/config" ? other : PREVIEW,
      import_ssh_config_apply: () => RESULT,
      get_connections: () => [],
      get_credentials: () => [],
    });
    await renderLoaded();

    const input = screen.getByTestId("import-path");
    await user.clear(input);
    await user.type(input, "/work/config{Enter}");
    await waitFor(() =>
      expect(calls("import_ssh_config_preview").at(-1)?.[1]).toEqual({ path: "/work/config" }),
    );
    await waitFor(() => expect(useImportStore.getState().preview?.path).toBe("/work/config"));

    await user.clear(input);
    await user.type(input, "/typed/but/not/read");
    await user.click(screen.getByTestId("import-confirm"));
    await screen.findByTestId("import-result");
    const applied = calls("import_ssh_config_apply")[0][1] as { input: { path: string } };
    expect(applied.input.path).toBe("/work/config");
  });

  it("treats a blank path as the default", async () => {
    const user = userEvent.setup();
    backendWith();
    await renderLoaded();
    await user.clear(screen.getByTestId("import-path"));
    await user.click(screen.getByTestId("import-load"));
    await waitFor(() =>
      expect(calls("import_ssh_config_preview").at(-1)?.[1]).toEqual({ path: null }),
    );
  });

  it("reads the file the picker chose", async () => {
    const user = userEvent.setup();
    backendWith();
    vi.mocked(pickFile).mockResolvedValue("/picked/config");
    await renderLoaded();
    await user.click(screen.getByRole("button", { name: /browse/i }));
    await waitFor(() =>
      expect(calls("import_ssh_config_preview").at(-1)?.[1]).toEqual({ path: "/picked/config" }),
    );
    expect(screen.getByTestId("import-path")).toHaveValue("/picked/config");
  });

  it("drops an answer that comes after the path has moved on", async () => {
    const user = userEvent.setup();
    let answerFirst: (preview: ImportPreview) => void = () => {};
    let previews = 0;
    mockBackend({
      import_ssh_config_preview: () =>
        previews++ === 0
          ? new Promise((resolve) => {
              answerFirst = resolve;
            })
          : { ...PREVIEW, items: [item("latest")] },
    });
    vi.mocked(pickFile).mockResolvedValue("/picked/config");
    renderDialog();
    await waitFor(() => expect(previews).toBe(1));
    // Read file is disabled while loading; the picker is not.
    await user.click(screen.getByRole("button", { name: /browse/i }));
    await screen.findByText("latest");

    answerFirst({ ...PREVIEW, items: [item("stale")] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("stale")).toBeNull();
    expect(screen.getByText("latest")).toBeInTheDocument();
  });

  it("describes itself for assistive technology", async () => {
    backendWith();
    await renderLoaded();
    const dialog = screen.getByRole("dialog");
    const describedBy = dialog.getAttribute("aria-describedby");
    expect(document.getElementById(describedBy!)).toHaveTextContent("Nothing is saved until");
    expect(screen.getByRole("button", { name: /browse/i })).toHaveAccessibleName();
    for (const checkboxEl of screen.getAllByRole("checkbox")) {
      expect(checkboxEl).toHaveAccessibleName();
    }
  });

  it("opens in the side panel", async () => {
    backendWith();
    const { slot } = renderInPanel(<ImportDialog open onOpenChange={vi.fn()} />);
    await screen.findAllByTestId("import-item");
    expect(slot()).toContainElement(screen.getByTestId("import-dialog"));
  });

  it("starts over each time it opens and forgets the preview when it closes", async () => {
    const user = userEvent.setup();
    backendWith();
    render(<ImportButton />);
    expect(screen.queryByTestId("import-dialog")).toBeNull();
    expect(calls("import_ssh_config_preview")).toEqual([]);

    await user.click(screen.getByTestId("import-config-button"));
    await screen.findAllByTestId("import-item");
    await user.click(checkbox("web"));
    await user.clear(screen.getByTestId("import-path"));
    await user.type(screen.getByTestId("import-path"), "/other");

    await user.click(screen.getByTestId("import-close"));
    await waitFor(() => expect(screen.queryByTestId("import-dialog")).toBeNull());
    expect(useImportStore.getState().preview).toBeNull();

    await user.click(screen.getByTestId("import-config-button"));
    await screen.findAllByTestId("import-item");
    expect(checkbox("web")).toBeChecked();
    expect(screen.getByTestId("import-path")).toHaveValue("~/.ssh/config");
  });

  it("is reached from the Connections header", async () => {
    const user = userEvent.setup();
    backendWith();
    useConnectionsStore.setState({ connections: [], error: null, isLoading: false });
    useCredentialsStore.setState({ credentials: [], error: null, isLoading: false });
    render(
      <ConnectionsView
        connections={[]}
        credentials={[]}
        settings={{ connection_layout: "list" } as AppSettings}
        onLayoutChange={vi.fn()}
        onSubmit={vi.fn()}
        onCloneSubmit={vi.fn()}
        onDiscardCredential={vi.fn()}
        onCreateCredential={vi.fn()}
        onDelete={vi.fn()}
        onConnect={vi.fn()}
        onConnectAllInTag={vi.fn()}
        onScpAllInTag={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("import-config-button"));
    expect(await screen.findByTestId("import-dialog")).toBeInTheDocument();
  });
});
