import { openExternalUrl } from "@/lib/externalLinks";
import { useTerminalLinksStore } from "@/store/useTerminalLinksStore";
import { ConfirmDialog } from "../ConfirmDialog";

/**
 * Shows where a link really goes before it opens. See `activateTerminalLink`
 * for which links ask. The host gets its own line because the URL can be built
 * to read like another site.
 */
export function TerminalLinkConfirm() {
  const url = useTerminalLinksStore((s) => s.confirming);
  const setConfirming = useTerminalLinksStore((s) => s.setConfirming);
  return (
    <ConfirmDialog
      open={!!url}
      onOpenChange={(open) => !open && setConfirming(null)}
      title="Open this link?"
      description={
        url && (
          <>
            The text a terminal shows for a link can say anything. This one goes to{" "}
            <strong data-testid="terminal-link-confirm-host">{url.hostname}</strong>:
            <span
              className="mt-2 block break-all font-mono text-xs"
              data-testid="terminal-link-confirm-url"
            >
              {url.href}
            </span>
          </>
        )
      }
      confirmLabel="Open link"
      testId="terminal-link-confirm"
      onConfirm={async () => {
        if (url) await openExternalUrl(url.href);
      }}
    />
  );
}
