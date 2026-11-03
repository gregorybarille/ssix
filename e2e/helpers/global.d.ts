/** Test hooks installed by `src/lib/terminalRegistry.ts`. */
interface Window {
  __ssixTerminalText?: (sessionId?: string) => string | null;
  __ssixTerminalState?: (sessionId: string) => {
    cols: number;
    rows: number;
    fontSize: number | undefined;
    fontFamily: string | undefined;
    background: string | undefined;
    bracketedPaste: boolean;
    altScreen: boolean;
    focused: boolean;
    viewportY: number;
    hasSelection: boolean;
  } | null;
}
