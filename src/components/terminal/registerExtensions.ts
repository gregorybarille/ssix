import { autoCopySelection } from "./autoCopySelection";
import { broadcastInput } from "./broadcastInput";
import { registerTerminalExtension } from "./extensions";
import { pasteGuard } from "./pasteGuard";
import { terminalLinks } from "./terminalLinks";
import { terminalSearch } from "./terminalSearch";

/**
 * Every terminal extension, in the order their hooks run. `Terminal.tsx`
 * imports this file for its effect. Add yours under your stream's anchor.
 */
registerTerminalExtension(autoCopySelection);
// roadmap:terminal-ux
registerTerminalExtension(terminalSearch);
registerTerminalExtension(terminalLinks);
// Before broadcast, so the other pane gets the cleaned text too.
registerTerminalExtension(pasteGuard);
registerTerminalExtension(broadcastInput);
