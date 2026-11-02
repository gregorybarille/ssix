import { WebLinksAddon } from "@xterm/addon-web-links";
import { errorMessage } from "@/lib/errors";
import { isLinkOpenClick, openExternalUrl, parseExternalUrl } from "@/lib/externalLinks";
import { log as appLog } from "@/lib/log";
import { useTerminalLinksStore } from "@/store/useTerminalLinksStore";
import type { TerminalExtension } from "./extensions";

/**
 * Open a link from terminal output, which is untrusted. Every path comes
 * through here:
 *
 * - Only `http` and `https` open (`parseExternalUrl`); anything else is logged.
 * - It takes Cmd or Ctrl+click (`isLinkOpenClick`), so a stray click does nothing.
 * - `viaHyperlink` marks an OSC 8 hyperlink. The server chooses its visible text
 *   and its target separately, so the text may name another site entirely: the
 *   user confirms the real target first. A URL with a user name gets the same,
 *   since `https://bank.example@evil.example/` goes to `evil.example`.
 */
export function activateTerminalLink(event: MouseEvent, raw: string, viaHyperlink: boolean): void {
  if (!isLinkOpenClick(event)) return;
  const url = parseExternalUrl(raw);
  if (!url) {
    appLog.warn("terminal", `Refused to open a link from terminal output: ${raw}`);
    return;
  }
  if (viaHyperlink || url.username || url.password) {
    useTerminalLinksStore.getState().setConfirming(url);
    return;
  }
  openExternalUrl(url.href).catch((error) => {
    appLog.error("terminal", `Could not open ${url.href}: ${errorMessage(error)}`);
  });
}

/**
 * Clickable links in a terminal: URLs found in its text through
 * `@xterm/addon-web-links`, and OSC 8 hyperlinks, which xterm detects itself
 * and hands to `linkHandler`. While the mouse is over either, `TerminalPaneOverlays`
 * shows the real target. xterm does not offer an OSC 8 link with another
 * scheme at all (`allowNonHttpProtocols` stays off).
 */
export const terminalLinks: TerminalExtension = {
  id: "terminal-links",
  onCreate({ term, sessionId }) {
    const links = useTerminalLinksStore.getState();
    const hover = (url: string) => {
      if (parseExternalUrl(url)) links.setHover({ sessionId, url });
    };
    const leave = () => links.clearHover(sessionId);
    term.loadAddon(
      new WebLinksAddon((event, url) => activateTerminalLink(event, url, false), {
        hover: (_event, url) => hover(url),
        leave,
      }),
    );
    term.options.linkHandler = {
      activate: (event, url) => activateTerminalLink(event, url, true),
      hover: (_event, url) => hover(url),
      leave,
    };
    return leave;
  },
};
