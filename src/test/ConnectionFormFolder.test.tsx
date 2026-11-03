import { chooseSelectValue } from "./radixSelect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionForm } from "@/components/ConnectionForm";
import { useConnectionsStore } from "@/store/useConnectionsStore";
import type { Connection, Credential } from "@/types";

const cred: Credential = { id: "c1", name: "root", username: "root", type: "password", password: "" };

const saved: Connection = {
  id: "web",
  name: "web",
  host: "web.example",
  port: 22,
  type: "direct",
  credential_id: cred.id,
  folder: "prod",
};

const tunnel: Connection = {
  id: "fwd",
  name: "fwd",
  host: "gw",
  port: 22,
  type: "dynamic_forward",
  gateway_host: "gw",
  gateway_port: 22,
  gateway_credential_id: cred.id,
  local_port: 1080,
  folder: "prod/tunnels",
};

function renderForm(connection: Connection | null, { isClone = false } = {}) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  render(
    <ConnectionForm
      open
      onOpenChange={onOpenChange}
      connection={connection}
      credentials={[cred]}
      onSubmit={onSubmit}
      isClone={isClone}
    />,
  );
  return { onSubmit, onOpenChange };
}

const folderField = () => screen.getByTestId("connection-form-folder");
const submit = () => screen.getByTestId("connection-form-submit");

async function expectSavedInNoFolder(
  user: ReturnType<typeof userEvent.setup>,
  onSubmit: ReturnType<typeof vi.fn>,
) {
  await user.click(submit());
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  expect(onSubmit.mock.calls[0][0].folder).toBeUndefined();
}

beforeEach(() => {
  act(() => useConnectionsStore.setState({ connections: [saved, tunnel] }));
});

afterEach(() => {
  act(() => useConnectionsStore.setState({ connections: [] }));
});

describe("ConnectionForm's folder", () => {
  it("offers the folders that exist, and a typed one is saved in stored form", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm(saved);
    expect(folderField()).toHaveValue("prod");
    await user.click(screen.getByTestId("folder-picker-toggle"));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "prod",
      "prod/tunnels",
    ]);
    await user.clear(folderField());
    await user.type(folderField(), " /staging//eu/ ");
    await user.click(submit());
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ folder: "staging/eu" })),
    );
  });

  it("takes an existing folder from the list", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm({ ...saved, id: "unfiled", folder: undefined });
    await user.click(folderField());
    await user.type(folderField(), "tun");
    await user.click(screen.getByRole("option", { name: "prod/tunnels" }));
    await user.click(submit());
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ folder: "prod/tunnels" })),
    );
  });

  it("clears the folder when the field is emptied", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm(saved);
    await user.clear(folderField());
    await expectSavedInNoFolder(user, onSubmit);
  });

  it("shows a bad path inline as it is typed, and refuses to save it", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm(saved);
    await user.clear(folderField());
    await user.type(folderField(), "a/..");
    const error = await screen.findByTestId("connection-form-folder-error");
    expect(error).toHaveTextContent("A folder cannot be named . or ..");
    expect(folderField()).toHaveAttribute("aria-invalid", "true");
    expect(folderField()).toHaveAttribute("aria-describedby", "folder-error");

    await user.click(submit());
    await screen.findByText("Please fix the highlighted fields");
    expect(onSubmit).not.toHaveBeenCalled();

    await user.clear(folderField());
    expect(screen.queryByTestId("connection-form-folder-error")).not.toBeInTheDocument();
  });

  it("marks the form dirty when the folder changes, and clean again when it is restored", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderForm(saved);
    await user.type(folderField(), "x");
    await user.click(screen.getByTestId("connection-form-cancel"));
    expect(await screen.findByText("Discard unsaved changes?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));

    await user.type(folderField(), "{Backspace}");
    await user.click(screen.getByTestId("connection-form-cancel"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not offer the field for a forward, and keeps the folder it has", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm(tunnel);
    expect(screen.queryByTestId("connection-form-folder")).not.toBeInTheDocument();
    await user.click(submit());
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ folder: "prod/tunnels" })),
    );
  });

  /** Leave text the field refuses, then go to a kind that hides the field. */
  const hideRefusedFolder = async (user: ReturnType<typeof userEvent.setup>) => {
    chooseSelectValue(screen.getByTestId("connection-form-type"), "direct");
    await user.clear(folderField());
    await user.type(folderField(), "a/..");
    expect(await screen.findByTestId("connection-form-folder-error")).toBeInTheDocument();
    chooseSelectValue(screen.getByTestId("connection-form-type"), "dynamic_forward");
    expect(screen.queryByTestId("connection-form-folder")).not.toBeInTheDocument();
  };

  it("lets bad text left in the hidden field give way to the saved folder", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm(tunnel);
    await hideRefusedFolder(user);
    await user.click(submit());
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "dynamic_forward", folder: "prod/tunnels" }),
      ),
    );
  });

  it("gives way to where the row is now, not where it was when the form opened", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm(tunnel);
    await hideRefusedFolder(user);
    act(() =>
      useConnectionsStore.setState({ connections: [saved, { ...tunnel, folder: "dragged/here" }] }),
    );
    await user.click(submit());
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ folder: "dragged/here" })),
    );
  });

  it("clones into the same folder", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm(saved, { isClone: true });
    expect(folderField()).toHaveValue("prod");
    await user.click(submit());
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ folder: "prod" })),
    );
  });

  describe("while the connection moves under the open form", () => {
    const moveTo = (folder: string | undefined) =>
      act(() =>
        useConnectionsStore.setState({ connections: [{ ...saved, folder }, tunnel] }),
      );

    it("follows the stored folder, stays clean and does not put it back on save", async () => {
      const user = userEvent.setup();
      const { onSubmit, onOpenChange } = renderForm(saved);
      moveTo("staging");
      expect(folderField()).toHaveValue("staging");

      await user.click(screen.getByTestId("connection-form-cancel"));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(screen.queryByText("Discard unsaved changes?")).not.toBeInTheDocument();

      await user.click(submit());
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ folder: "staging" })),
      );
    });

    it("follows a deleted folder too", async () => {
      const user = userEvent.setup();
      const { onSubmit } = renderForm(saved);
      moveTo(undefined);
      expect(folderField()).toHaveValue("");
      await expectSavedInNoFolder(user, onSubmit);
    });

    it("keeps a folder the user typed", async () => {
      const user = userEvent.setup();
      const { onSubmit } = renderForm(saved);
      await user.clear(folderField());
      await user.type(folderField(), "mine");
      moveTo("staging");
      expect(folderField()).toHaveValue("mine");
      await user.click(submit());
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ folder: "mine" })),
      );
    });

    it("leaves a new connection's folder alone", async () => {
      const user = userEvent.setup();
      renderForm(null);
      await user.type(folderField(), "mine");
      moveTo("staging");
      expect(folderField()).toHaveValue("mine");
    });
  });
});
