/**
 * High-level interaction flows used across multiple specs.
 *
 * These wrap repetitive WDIO sequences (open form, fill, submit) so
 * specs read closer to "what is being tested" than "how WDIO works".
 * Each helper waits for its observable side-effect (form closed, list
 * row appeared, terminal output present) so callers can chain.
 */
import { sel } from "./selectors.js";

async function fill(selector: string, value: string): Promise<void> {
  const el = await browser.$(selector);
  await el.waitForExist({ timeout: 10_000 });
  await el.waitForClickable({ timeout: 10_000 });
  // setValue clears + types — matches user-event semantics of unit tests.
  await el.setValue(value);
}

async function click(selector: string): Promise<void> {
  const el = await browser.$(selector);
  await el.waitForClickable({ timeout: 10_000 });
  await el.click();
}

export async function navigateTo(view: "connections" | "credentials" | "tunnels" | "settings" | "git-sync" | "logs"): Promise<void> {
  const map = {
    connections: sel.navConnections,
    credentials: sel.navCredentials,
    tunnels: sel.navTunnels,
    settings: sel.navSettings,
    "git-sync": sel.navGitSync,
    logs: sel.navLogs,
  } as const;
  await click(map[view]);
}

export interface PasswordCredentialInput {
  name: string;
  username: string;
  password: string;
}

export async function createPasswordCredential(input: PasswordCredentialInput): Promise<void> {
  await navigateTo("credentials");
  await click(sel.addCredentialButton);
  await fill(sel.credentialFormName, input.name);
  await fill(sel.credentialFormUsername, input.username);
  await click(sel.credentialFormKindPassword);
  await fill(sel.credentialFormPassword, input.password);
  await click(sel.credentialFormSubmit);
  // form closes on success
  const form = await browser.$(sel.credentialForm);
  await form.waitForExist({ reverse: true, timeout: 10_000 });
}

export interface DirectConnectionInput {
  name: string;
  host: string;
  port: number;
  credentialName: string;
}

export async function createDirectConnection(input: DirectConnectionInput): Promise<void> {
  await navigateTo("connections");
  await click(sel.addConnectionButton);
  await fill(sel.connectionFormName, input.name);
  await click(sel.connectionFormKindDirect);
  await fill(sel.connectionFormHost, input.host);
  await fill(sel.connectionFormPort, String(input.port));
  // Credential picker — implementation-specific; tests select by visible
  // label. Adjust selector once the picker exposes its options.
  const credentialPicker = await browser.$(sel.connectionFormCredential);
  await credentialPicker.waitForClickable({ timeout: 10_000 });
  await credentialPicker.click();
  const opt = await browser.$(`[role="option"][data-name="${input.credentialName}"]`);
  await opt.waitForClickable({ timeout: 10_000 });
  await opt.click();
  await click(sel.connectionFormSubmit);
  const form = await browser.$(sel.connectionForm);
  await form.waitForExist({ reverse: true, timeout: 10_000 });
}

/**
 * Open a connection by clicking its visible "Connect" button. The
 * row's outer click handler is wired to onSelect, not onConnect, so
 * doubleClick() on the row won't reliably start a session — the only
 * direct UI affordance is the per-row connect button (always visible,
 * not hidden behind hover state).
 */
export async function connectToConnection(name: string): Promise<void> {
  await navigateTo("connections");
  const row = await browser.$(sel.connectionRowByName(name));
  await row.waitForExist({ timeout: 10_000 });
  const btn = await row.$('[data-testid^="connect-button-"]');
  await btn.waitForClickable({ timeout: 10_000 });
  await btn.click();
}

/**
 * Read the visible terminal text. xterm.js renders rows as
 * `.xterm-rows > div`; we concatenate them.
 */
export async function readTerminalText(): Promise<string> {
  const rows = await browser.$$(`${sel.terminalContainer} .xterm-rows > div`);
  const parts: string[] = [];
  for (const r of rows) {
    parts.push(await r.getText());
  }
  return parts.join("\n");
}

export async function waitForTerminalContains(needle: string, timeoutMs = 30_000): Promise<void> {
  await browser.waitUntil(
    async () => (await readTerminalText()).includes(needle),
    {
      timeout: timeoutMs,
      timeoutMsg: `Terminal did not contain ${JSON.stringify(needle)} within ${timeoutMs}ms`,
    },
  );
}

/**
 * Type into the focused terminal. xterm.js forwards keystrokes from
 * its hidden textarea, so we focus the container then send keys.
 */
export async function typeIntoTerminal(text: string): Promise<void> {
  const term = await browser.$(sel.terminalContainer);
  await term.click();
  await browser.keys(text.split(""));
}
