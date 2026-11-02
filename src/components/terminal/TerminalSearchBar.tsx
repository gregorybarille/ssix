import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  findInTerminal,
  onSearchResults,
  SEARCH_HIGHLIGHT_LIMIT,
  type SearchDirection,
  type SearchResults,
} from "@/lib/terminalSearch";
import { useTerminalSearchStore } from "@/store/useTerminalSearchStore";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

function resultsLabel(results: SearchResults): string {
  if (results.count === 0) return "No matches";
  if (results.index >= 0) return `${results.index + 1} of ${results.count}`;
  return results.count >= SEARCH_HIGHLIGHT_LIMIT
    ? `More than ${SEARCH_HIGHLIGHT_LIMIT} matches`
    : `${results.count} matches`;
}

/**
 * Find in one pane's scrollback (Mod+F). It docks over a corner of the pane
 * rather than taking a row from it, which would resize the session just for a
 * search. Enter goes to the next match, Shift+Enter to the previous, and
 * Escape closes the bar and hands the keyboard back to the terminal.
 */
export function TerminalSearchBar({
  sessionId,
  atBottom,
}: {
  sessionId: string;
  /** The top of the pane is taken by its connection status. */
  atBottom: boolean;
}) {
  const focusRequest = useTerminalSearchStore((s) => s.focusRequest);
  const close = useTerminalSearchStore((s) => s.close);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  useEffect(() => onSearchResults(sessionId, setResults), [sessionId]);

  const search = (text: string) => {
    setQuery(text);
    // An empty query clears the highlights.
    findInTerminal(sessionId, text, "next", true);
  };

  const move = (direction: SearchDirection) => {
    if (query) findInTerminal(sessionId, query, direction);
  };

  // The addon also reports "no results" for an empty query.
  const shown = query ? results : null;
  const noMatches = shown?.count === 0;
  const canMove = !!query && !noMatches;

  return (
    <div
      role="search"
      aria-label="Find in terminal"
      data-testid="terminal-search"
      className={cn(
        "absolute right-4 z-20 flex items-center gap-1 rounded-md border border-border bg-card p-1 shadow-md",
        atBottom ? "bottom-2" : "top-2",
      )}
    >
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => search(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          } else if (e.key === "Enter") {
            e.preventDefault();
            move(e.shiftKey ? "previous" : "next");
          }
        }}
        placeholder="Find"
        aria-label="Find in terminal"
        aria-invalid={noMatches || undefined}
        aria-describedby="terminal-search-status"
        className="h-7 w-44"
        data-testid="terminal-search-input"
      />
      <span
        id="terminal-search-status"
        role="status"
        aria-live="polite"
        data-testid="terminal-search-status"
        className={cn(
          "min-w-16 whitespace-nowrap px-1 text-center text-xs",
          noMatches ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {shown ? resultsLabel(shown) : ""}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        aria-label="Previous match"
        disabled={!canMove}
        onClick={() => move("previous")}
        data-testid="terminal-search-previous"
      >
        <ChevronUp aria-hidden="true" className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        aria-label="Next match"
        disabled={!canMove}
        onClick={() => move("next")}
        data-testid="terminal-search-next"
      >
        <ChevronDown aria-hidden="true" className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        aria-label="Close find"
        onClick={() => close()}
        data-testid="terminal-search-close"
      >
        <X aria-hidden="true" className="h-4 w-4" />
      </Button>
    </div>
  );
}
