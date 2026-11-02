/**
 * Losing a session and watching it come back, for the specs that need to.
 *
 * A session is lost from the server's side, over the shell itself, since the
 * runner cannot control the Docker daemon: see spec 15's header.
 */
import { readTerminalText, typeIntoTerminal, waitForTerminalContains } from "./flows.js";
import { sel } from "./selectors.js";

export const RECONNECTED = "[SSIX] Reconnected.";
/** Longer than the wait before a next attempt would start. */
export const NO_RETRY_WINDOW_MS = 6_000;

export const cutConnection = () => typeIntoTerminal("kill -9 $PPID\n");

/** The pid of the session's sshd, to clean up after freezing it. */
export async function sshdPid(): Promise<string> {
  await typeIntoTerminal("echo PID=$PPID\n");
  let pid: string | undefined;
  await browser.waitUntil(
    async () => {
      pid = /^PID=(\d+)/m.exec(await readTerminalText())?.[1];
      return !!pid;
    },
    { timeout: 15_000, timeoutMsg: "The shell did not print its parent's pid" },
  );
  return pid as string;
}

export async function waitForPhase(phase: "waiting" | "stopped", timeoutMs = 30_000) {
  const status = await browser.$(sel.reconnectStatusPhase(phase));
  await status.waitForExist({ timeout: timeoutMs });
  return status;
}

/**
 * The shell came back in this pane: one terminal, with what it held before
 * still above the reconnect line. A cursor sent back up the screen by the drop
 * would write that line over the old output.
 */
export async function expectReconnected(...kept: string[]): Promise<void> {
  await waitForTerminalContains(RECONNECTED, 40_000);
  await (await browser.$(sel.reconnectStatus)).waitForExist({ reverse: true, timeout: 10_000 });
  expect(await browser.$$(sel.terminalContainer).length).toBe(1);
  const text = await readTerminalText();
  for (const line of kept) {
    expect(text).toContain(line);
    expect(text.indexOf(line)).toBeLessThan(text.indexOf(RECONNECTED));
  }
}
