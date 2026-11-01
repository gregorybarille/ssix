import { autoCopySelection } from "./autoCopySelection";
import { registerTerminalExtension } from "./extensions";

/**
 * Every terminal extension, in the order their hooks run. `Terminal.tsx`
 * imports this file for its effect. Add yours under your stream's anchor.
 */
registerTerminalExtension(autoCopySelection);
// roadmap:terminal-ux
