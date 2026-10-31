import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ScriptsView } from "@/components/views/ScriptsView";
import { invoke } from "@/lib/tauri";
import { useScriptsStore } from "@/store/useScriptsStore";
import { useConnectionsStore } from "@/store/useConnectionsStore";
import type { Connection, Script, ScriptResult } from "@/types";
import { renderInPanel } from "./panel";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

const script: Script = { id: "s1", name: "uptime", body: "uptime\n", interpreter: "sh -s" };

const connections: Connection[] = [
  { id: "a", name: "web", host: "web", port: 22, type: "direct", credential_id: "c" },
  { id: "b", name: "db", host: "db", port: 22, type: "direct", credential_id: "c" },
  {
    id: "f",
    name: "tunnel",
    host: "",
    port: 22,
    type: "port_forward",
    gateway_host: "gw",
    gateway_port: 22,
    gateway_credential_id: "c",
    local_port: 8080,
    destination_host: "x",
    destination_port: 80,
  },
];

const ok = (stdout: string): ScriptResult => ({
  stdout,
  stderr: "",
  exit_code: 0,
  exit_signal: null,
  duration_ms: 42,
  truncated: false,
  timed_out: false,
  cancelled: false,
});

function respond(handlers: Record<string, (args?: Record<string, unknown>) => unknown>) {
  mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    const handler = handlers[cmd];
    if (!handler) return [];
    return handler(args);
  });
}

describe("ScriptsView", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    useScriptsStore.setState({
      scripts: [],
      error: null,
      isLoading: false,
      run: null,
      running: false,
      cancelling: false,
    });
    useConnectionsStore.setState({ connections });
  });

  it("creates a script in the side panel beside the list", async () => {
    respond({
      get_scripts: () => [],
      add_script: (args) => ({ id: "new", ...(args!.input as object) }),
    });
    const { slot } = renderInPanel(<ScriptsView />);
    expect(await screen.findByText("No scripts yet")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("add-script-button"));
    const form = await screen.findByTestId("script-form");
    expect(slot()).toContainElement(form);

    fireEvent.change(screen.getByTestId("script-form-name"), { target: { value: "disk" } });
    fireEvent.click(screen.getByRole("button", { name: "bash -s" }));
    fireEvent.change(screen.getByTestId("script-form-body"), { target: { value: "df -h" } });
    fireEvent.click(screen.getByTestId("script-form-submit"));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("add_script", {
        input: { name: "disk", interpreter: "bash -s", body: "df -h" },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("script-form")).not.toBeInTheDocument());
    const row = await screen.findByTestId("script-row");
    expect(row).toHaveAttribute("data-name", "disk");
    expect(within(screen.getByTestId("script-run-area")).getByText("df -h")).toBeInTheDocument();
  });

  it("flags the empty fields instead of saving", async () => {
    respond({ get_scripts: () => [] });
    renderInPanel(<ScriptsView />);
    fireEvent.click(await screen.findByTestId("add-script-button"));
    // Native `required` validation stops a click; submit as Enter would
    // after the user cleared a field.
    fireEvent.submit(await screen.findByTestId("script-form"));
    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(screen.getByText("The script is empty")).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith("add_script", expect.anything());
  });

  it("runs on every picked host at once and shows each host's outcome", async () => {
    const pending: Record<string, { resolve: (r: ScriptResult) => void; reject: (e: unknown) => void }> = {};
    respond({
      get_scripts: () => [script],
      begin_script_run: () => 7,
      run_script: (args) =>
        new Promise((resolve, reject) => {
          expect(args!.run).toBe(7);
          pending[args!.connectionId as string] = { resolve, reject };
        }),
    });
    renderInPanel(<ScriptsView />);
    await screen.findByTestId("script-run-area");

    const hosts = screen.getAllByTestId("script-host").map((h) => h.getAttribute("data-name"));
    expect(hosts).toEqual(["web", "db"]);
    expect(screen.getByTestId("script-run")).toBeDisabled();

    fireEvent.click(screen.getByTestId("script-hosts-all"));
    fireEvent.click(screen.getByTestId("script-run"));

    // Both hosts start before either finishes.
    await waitFor(() => expect(Object.keys(pending).sort()).toEqual(["a", "b"]));
    expect(screen.getByTestId("script-run")).toBeDisabled();

    pending.a.resolve(ok(" 10:00 up 3 days\n"));
    pending.b.reject("Authentication failed");

    await waitFor(() => {
      const results = screen.getAllByTestId("script-result");
      expect(results.map((r) => r.getAttribute("data-status"))).toEqual(["success", "error"]);
    });
    const [web, db] = screen.getAllByTestId("script-result");
    expect(web).toHaveAttribute("data-exit-code", "0");
    expect(within(web).getByTestId("script-result-stdout")).toHaveTextContent("10:00 up 3 days");
    expect(within(web).getByText("exit 0 · 42 ms")).toBeInTheDocument();
    expect(within(db).getByText("Authentication failed")).toBeInTheDocument();
    expect(screen.getByTestId("script-run")).toHaveTextContent("Run on 2 hosts");
  });

  it("cancels the hosts still running and keeps what finished", async () => {
    const pending: Record<string, (r: ScriptResult) => void> = {};
    respond({
      get_scripts: () => [script],
      begin_script_run: () => 3,
      cancel_script_run: () => null,
      run_script: (args) =>
        new Promise((resolve) => {
          pending[args!.connectionId as string] = resolve;
        }),
    });
    renderInPanel(<ScriptsView />);
    expect(await screen.findByTestId("script-run-area")).toBeInTheDocument();
    expect(screen.queryByTestId("script-cancel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("script-hosts-all"));
    fireEvent.click(screen.getByTestId("script-run"));
    await waitFor(() => expect(Object.keys(pending)).toHaveLength(2));

    pending.a(ok("done\n"));
    fireEvent.click(screen.getByTestId("script-cancel"));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("cancel_script_run", { run: 3 }));
    expect(screen.getByTestId("script-cancel")).toHaveTextContent("Cancelling...");
    pending.b({ ...ok("partial\n"), exit_code: null, exit_signal: "TERM", cancelled: true });

    await waitFor(() => expect(screen.queryByTestId("script-cancel")).not.toBeInTheDocument());
    const [web, db] = screen.getAllByTestId("script-result");
    expect(web).toHaveAttribute("data-status", "success");
    expect(db).toHaveAttribute("data-status", "cancelled");
    expect(within(db).getByText(/^cancelled ·/)).toBeInTheDocument();
    expect(within(db).getByTestId("script-result-stdout")).toHaveTextContent("partial");
  });

  it("deletes a script only after confirming", async () => {
    respond({ get_scripts: () => [script], delete_script: () => null });
    renderInPanel(<ScriptsView />);
    fireEvent.click(await screen.findByTestId("script-row-delete"));
    expect(mockInvoke).not.toHaveBeenCalledWith("delete_script", expect.anything());
    fireEvent.click(screen.getByTestId("script-delete-dialog-confirm"));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("delete_script", { id: "s1" }));
    expect(await screen.findByText("No scripts yet")).toBeInTheDocument();
  });

  it("asks before replacing an editor with unsaved changes", async () => {
    respond({ get_scripts: () => [script, { ...script, id: "s2", name: "other" }] });
    renderInPanel(<ScriptsView />);
    const [first, second] = await screen.findAllByTestId("script-row-edit");
    fireEvent.click(first);
    fireEvent.change(await screen.findByTestId("script-form-body"), { target: { value: "id" } });
    fireEvent.click(second);
    expect(await screen.findByText("Discard unsaved changes?")).toBeInTheDocument();
    expect(screen.getByTestId("script-form-name")).toHaveValue("uptime");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.getByTestId("script-form-name")).toHaveValue("other"));
  });
});
