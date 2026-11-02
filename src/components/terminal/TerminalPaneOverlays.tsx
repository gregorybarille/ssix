import { useEffect } from "react";
import { linkModifierLabel } from "@/lib/externalLinks";
import { useTerminalLinksStore } from "@/store/useTerminalLinksStore";
import { useTerminalSearchStore } from "@/store/useTerminalSearchStore";
import { TerminalSearchBar } from "./TerminalSearchBar";

/**
 * What a live terminal's pane shows over its text: the find bar and the target
 * of the link under the mouse. Neither outlives the pane being hidden, so the
 * search only ever acts on a pane the user can see, and a hint cannot linger.
 */
export function TerminalPaneOverlays({
  sessionId,
  isVisible,
  statusShown,
}: {
  sessionId: string;
  isVisible: boolean;
  /** The pane's connection status is docked along its top. */
  statusShown: boolean;
}) {
  const searching = useTerminalSearchStore((s) => s.sessionId === sessionId);
  const closeSearch = useTerminalSearchStore((s) => s.close);
  const hoveredUrl = useTerminalLinksStore((s) =>
    s.hover?.sessionId === sessionId ? s.hover.url : null,
  );
  const clearHover = useTerminalLinksStore((s) => s.clearHover);

  useEffect(() => {
    if (isVisible) return;
    if (searching) closeSearch({ refocus: false });
    clearHover(sessionId);
  }, [isVisible, searching, closeSearch, clearHover, sessionId]);

  if (!isVisible) return null;
  return (
    <>
      {searching && <TerminalSearchBar sessionId={sessionId} atBottom={statusShown} />}
      {hoveredUrl && (
        <div
          data-testid="terminal-link-hint"
          className="pointer-events-none absolute bottom-1 left-1 z-20 max-w-[90%] break-all rounded border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
        >
          <span className="font-mono">{hoveredUrl}</span>
          <span className="text-muted-foreground"> ({linkModifierLabel()}+click to open)</span>
        </div>
      )}
    </>
  );
}
