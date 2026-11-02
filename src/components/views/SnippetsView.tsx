import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Braces, ClipboardPaste, Plus } from "lucide-react";
import type { Snippet, SnippetInput } from "@/types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/EmptyState";
import { ErrorBanner } from "../ui/error-banner";
import { DeleteItemDialog, ItemRowActions } from "../ItemActions";
import { SnippetForm } from "../SnippetForm";
import { useEditorPanel } from "@/hooks/useEditorPanel";
import { paletteShortcutLabel } from "@/lib/snippets";
import { useSnippetsStore } from "@/store/useSnippetsStore";

/**
 * The Snippets tab: saved commands, with the editor in the side panel. Pasting
 * happens in `SnippetPalette`, which `App` mounts because the shortcut works
 * from every view.
 */
export function SnippetsView() {
  const { snippets, loadError, fetchSnippets, addSnippet, updateSnippet, deleteSnippet, openPalette } =
    useSnippetsStore(
      useShallow((s) => ({
        snippets: s.snippets,
        loadError: s.error,
        fetchSnippets: s.fetchSnippets,
        addSnippet: s.addSnippet,
        updateSnippet: s.updateSnippet,
        deleteSnippet: s.deleteSnippet,
        openPalette: s.openPalette,
      })),
    );

  useEffect(() => {
    void fetchSnippets();
  }, [fetchSnippets]);

  const { editing, openEditor, closeEditor, setFormGuard } = useEditorPanel<Snippet>();
  const [confirmDelete, setConfirmDelete] = useState<Snippet | null>(null);

  const submit = (input: SnippetInput) =>
    editing?.item ? updateSnippet(editing.item.id, input) : addSnippet(input);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-border">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Snippets</h1>
          <p className="text-xs text-muted-foreground">
            {paletteShortcutLabel()} pastes one into the active terminal. Nothing runs until you
            press Enter there.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={openPalette}
            data-testid="snippet-palette-button"
          >
            <ClipboardPaste className="h-4 w-4 mr-1" aria-hidden="true" />
            Paste
          </Button>
          <Button size="sm" onClick={() => openEditor(null)} data-testid="add-snippet-button">
            <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
            New Snippet
          </Button>
        </div>
      </div>
      {loadError && (
        <ErrorBanner
          className="mx-6 mt-2"
          message={`Could not load snippets: ${loadError}`}
          onRetry={() => void fetchSnippets()}
          testId="snippets-load-error"
        />
      )}
      {snippets.length === 0 ? (
        <EmptyState
          icon={Braces}
          title="No snippets yet"
          hint="Save a command once, with {{variables}} for what changes, and paste it into any terminal."
        />
      ) : (
        <ul
          className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1"
          aria-label="Snippets"
          data-testid="snippet-list"
        >
          {snippets.map((snippet) => (
            <li
              key={snippet.id}
              className="flex items-center gap-2 rounded-md px-3 py-1.5 hover:bg-accent/50"
              data-testid="snippet-row"
              data-name={snippet.name}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium truncate">{snippet.name}</span>
                  {snippet.tags?.map((tag) => (
                    <Badge key={tag} variant="secondary" className="shrink-0">
                      {tag}
                    </Badge>
                  ))}
                </div>
                <code className="block text-xs text-muted-foreground-soft truncate">
                  {snippet.command}
                </code>
              </div>
              <ItemRowActions
                name={snippet.name}
                testIdPrefix="snippet"
                onEdit={() => openEditor(snippet)}
                onDelete={() => setConfirmDelete(snippet)}
              />
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <SnippetForm
          key={editing.key}
          snippet={editing.item}
          onSubmit={submit}
          onClose={closeEditor}
          onGuardChange={setFormGuard}
        />
      )}
      <DeleteItemDialog
        item={confirmDelete}
        kind="snippet"
        onClose={() => setConfirmDelete(null)}
        onDelete={async (snippet) => {
          await deleteSnippet(snippet.id);
          if (editing?.item?.id === snippet.id) closeEditor();
        }}
      />
    </div>
  );
}
