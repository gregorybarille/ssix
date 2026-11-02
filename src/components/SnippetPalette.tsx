import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Search } from "lucide-react";
import type { Snippet } from "@/types";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ErrorBanner } from "./ui/error-banner";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { useFieldErrors } from "@/hooks/useFieldErrors";
import { useListboxNavigation } from "@/hooks/useListboxNavigation";
import { submitWithoutReset } from "@/lib/formSubmit";
import { tokenize } from "@/lib/search";
import {
  fillVariables,
  NO_TERMINAL_MESSAGE,
  planPaste,
  snippetMatches,
  snippetVariables,
} from "@/lib/snippets";
import { activeSessionId, focusSession, writeToSession } from "@/lib/terminalRegistry";
import { cn } from "@/lib/utils";
import { useSnippetsStore } from "@/store/useSnippetsStore";
import { useTerminalsStore } from "@/store/useTerminalsStore";
import { useViewStore } from "@/store/useViewStore";

const NO_VALUES: ReadonlyMap<string, string> = new Map();

/**
 * Pick a snippet, fill in its variables, and paste it into the active pane.
 * It never runs anything: see `preparePaste` for how. `App` mounts it only while
 * the palette is open, so its state starts fresh every time.
 */
export function SnippetPalette() {
  const { snippets, loadError, fetchSnippets, closePalette } = useSnippetsStore(
    useShallow((s) => ({
      snippets: s.snippets,
      loadError: s.error,
      fetchSnippets: s.fetchSnippets,
      closePalette: s.closePalette,
    })),
  );
  const tabs = useTerminalsStore((s) => s.tabs);
  const activeTabId = useTerminalsStore((s) => s.activeTabId);
  const view = useViewStore((s) => s.view);

  useEffect(() => {
    void fetchSnippets();
  }, [fetchSnippets]);

  // The registry is no store, so follow what changes it: tabs, and the view,
  // because terminals exist only on their own (each registers in its own
  // effect, which runs before this one). Clicking another pane retargets too.
  const [sessionId, setSessionId] = useState(activeSessionId);
  useEffect(() => {
    const refresh = () => setSessionId(activeSessionId());
    refresh();
    document.addEventListener("focusin", refresh);
    return () => document.removeEventListener("focusin", refresh);
  }, [tabs, activeTabId, view]);
  const paneName = tabs.flatMap((tab) => tab.panes).find((pane) => pane.sessionId === sessionId)
    ?.connectionName;

  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Snippet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pastedTo = useRef<string | null>(null);

  const paste = (command: string) => {
    const plan = planPaste(command);
    if ("error" in plan) {
      setError(plan.error);
    } else if (writeToSession(plan.sessionId, plan.text)) {
      pastedTo.current = plan.sessionId;
      closePalette();
    } else {
      setError(NO_TERMINAL_MESSAGE);
    }
  };

  const choose = (snippet: Snippet) => {
    setError(null);
    if (snippetVariables(snippet.command).length === 0) {
      paste(fillVariables(snippet.command, NO_VALUES));
      return;
    }
    // Refuse now what the values could not change, before asking for them.
    const plan = planPaste(snippet.command);
    if ("error" in plan) setError(plan.error);
    else setPicked(snippet);
  };

  const message = error ?? (sessionId ? null : NO_TERMINAL_MESSAGE);

  return (
    <Dialog open onOpenChange={(o) => !o && closePalette()}>
      <DialogContent
        className="p-0 gap-0 overflow-hidden"
        data-testid="snippet-palette"
        onCloseAutoFocus={(event) => {
          // After a paste the next key is the user's Enter, whatever had focus before.
          if (pastedTo.current) {
            event.preventDefault();
            focusSession(pastedTo.current);
          }
        }}
      >
        <DialogHeader className="px-6 pt-6 pb-3 shrink-0 border-b">
          <DialogTitle>{picked ? picked.name : "Paste a snippet"}</DialogTitle>
          <DialogDescription data-testid="snippet-palette-target">
            Pastes into {paneName ? <strong>{paneName}</strong> : "the active terminal"}. Nothing
            runs until you press Enter there.
          </DialogDescription>
        </DialogHeader>
        {loadError && (
          <ErrorBanner
            className="mx-6 mt-3"
            message={`Could not load snippets: ${loadError}`}
            onRetry={() => void fetchSnippets()}
            testId="snippet-palette-load-error"
          />
        )}
        {message && (
          <ErrorBanner
            className="mx-6 mt-3 shrink-0"
            message={message}
            testId="snippet-palette-error"
          />
        )}
        {picked ? (
          <VariablesForm
            snippet={picked}
            onBack={() => {
              setPicked(null);
              setError(null);
            }}
            onPaste={paste}
          />
        ) : (
          <SnippetPicker
            snippets={snippets}
            query={query}
            onQueryChange={(next) => {
              setQuery(next);
              setError(null);
            }}
            onChoose={choose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface SnippetPickerProps {
  snippets: Snippet[];
  query: string;
  onQueryChange: (query: string) => void;
  onChoose: (snippet: Snippet) => void;
}

function SnippetPicker({ snippets, query, onQueryChange, onChoose }: SnippetPickerProps) {
  const filtered = useMemo(() => {
    const tokens = tokenize(query);
    return snippets.filter((snippet) => snippetMatches(snippet, tokens));
  }, [snippets, query]);
  const { activeIndex, setActiveIndex, onKeyDown, listProps, rowProps } = useListboxNavigation({
    count: filtered.length,
    onChoose: (index) => onChoose(filtered[index]),
  });

  const listboxId = "snippet-palette-list";
  const expanded = filtered.length > 0;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b px-6 py-2">
        <Search className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
        <Input
          type="search"
          autoFocus
          value={query}
          onChange={(e) => {
            onQueryChange(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search by name, command or tag…"
          aria-label="Search snippets"
          role="combobox"
          aria-expanded={expanded}
          aria-autocomplete="list"
          aria-controls={expanded ? listboxId : undefined}
          aria-activedescendant={expanded ? `snippet-palette-row-${activeIndex}` : undefined}
          className="flex-1 h-auto border-0 bg-transparent px-0 py-0 ring-offset-0 focus-visible:ring-2 focus-visible:ring-offset-0"
          data-testid="snippet-palette-search"
        />
      </div>
      {snippets.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No snippets yet. Add one in the Snippets view.
        </p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No matches for “{query}”.</p>
      ) : (
        <div
          {...listProps}
          id={listboxId}
          role="listbox"
          aria-label="Matching snippets"
          className="flex-1 min-h-0 overflow-y-auto py-1"
        >
          {filtered.map((snippet, index) => (
            <div
              {...rowProps(index)}
              key={snippet.id}
              id={`snippet-palette-row-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              data-testid="snippet-palette-option"
              data-name={snippet.name}
              onClick={() => onChoose(snippet)}
              className={cn(
                "px-6 py-2 cursor-pointer transition-colors",
                index === activeIndex ? "bg-accent" : "hover:bg-accent/60",
              )}
            >
              <p className="text-sm font-medium truncate">{snippet.name}</p>
              <code className="block text-xs text-muted-foreground truncate">
                {snippet.command}
              </code>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

interface VariablesFormProps {
  snippet: Snippet;
  onBack: () => void;
  /** Called with the command, its variables filled in. */
  onPaste: (command: string) => void;
}

function VariablesForm({ snippet, onBack, onPaste }: VariablesFormProps) {
  const variables = useMemo(() => snippetVariables(snippet.command), [snippet.command]);
  // A Map, and errors keyed by position: a variable may be named `constructor`.
  const [values, setValues] = useState<ReadonlyMap<string, string>>(NO_VALUES);
  const { fieldErrors, setFieldErrors, clearFieldError } = useFieldErrors<string>();
  const filled = fillVariables(snippet.command, values);

  const submit = () => {
    const missing = variables.flatMap((name, index) => (values.get(name) ? [] : [index]));
    if (missing.length > 0) {
      setFieldErrors(
        Object.fromEntries(missing.map((index) => [`variable-${index}`, "Enter a value"])),
      );
      return;
    }
    onPaste(filled);
  };

  return (
    <form
      onSubmit={submitWithoutReset(submit)}
      noValidate
      className="flex flex-col flex-1 min-h-0"
      data-testid="snippet-variables-form"
    >
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
        {variables.map((name, index) => {
          const key = `variable-${index}`;
          const fieldError = fieldErrors[key];
          return (
            <div key={name} className="space-y-2">
              <Label htmlFor={`snippet-${key}`}>{name} *</Label>
              <Input
                id={`snippet-${key}`}
                autoFocus={index === 0}
                value={values.get(name) ?? ""}
                onChange={(e) => {
                  setValues(new Map(values).set(name, e.target.value));
                  clearFieldError(key);
                }}
                aria-required="true"
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? `snippet-${key}-error` : undefined}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                data-testid="snippet-variable"
                data-name={name}
              />
              {fieldError && (
                <p id={`snippet-${key}-error`} role="alert" className="text-xs text-destructive">
                  {fieldError}
                </p>
              )}
            </div>
          );
        })}
        <div className="space-y-2">
          <p className="text-sm font-medium">Will paste</p>
          <pre
            className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-muted px-3 py-2 font-mono text-xs"
            data-testid="snippet-variables-preview"
          >
            {filled}
          </pre>
          <p className="text-xs text-muted-foreground">
            Values go in exactly as typed, without shell quoting.
          </p>
        </div>
      </div>
      <DialogFooter className="px-6 py-3 border-t bg-background shrink-0 gap-2 sm:[&>button]:min-w-28">
        <Button type="button" variant="outline" onClick={onBack} data-testid="snippet-variables-back">
          Back
        </Button>
        <Button type="submit" data-testid="snippet-variables-submit">
          Paste
        </Button>
      </DialogFooter>
    </form>
  );
}
