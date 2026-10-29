/** Test hook installed by `src/lib/terminalRegistry.ts`. */
interface Window {
  __ssixTerminalText?: (sessionId?: string) => string | null;
}
