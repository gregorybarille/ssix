/**
 * High-level interaction flows used across multiple specs.
 *
 * These wrap repetitive WDIO sequences (open form, fill, submit) so
 * specs read closer to "what is being tested" than "how WDIO works".
 * Each helper waits for its observable side-effect (form closed, list
 * row appeared, terminal output present) so callers can chain.
 */
import { sel } from "./selectors.js";

export async function fill(selector: string, value: string): Promise<void> {
  const el = await browser.$(selector);
  await el.waitForExist({ timeout: 10_000 });
  await el.waitForClickable({ timeout: 10_000 });
  // setValue clears + types — matches user-event semantics of unit tests.
  await el.setValue(value);
}

export async function click(selector: string): Promise<void> {
  const el = await browser.$(selector);
  await el.waitForClickable({ timeout: 10_000 });
  await el.click();
}

export async function clickDialogFooterButton(selector: string): Promise<void> {
  const el = await browser.$(selector);
  await el.waitForExist({ timeout: 10_000 });

  // Linux tauri-driver/WebKit can stale element handles while dialog
  // footers reflow. Work purely from the selector inside the page so
  // scroll + click target the current live node instead of a cached
  // WebDriver element reference.
  await browser.execute((targetSelector: string) => {
    const button = document.querySelector<HTMLElement>(targetSelector);
    if (!button) {
      throw new Error(`Dialog footer button not found: ${targetSelector}`);
    }
    button.scrollIntoView({ block: "center" });
    button.click();
  }, selector);
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

/**
 * Open the editor for the credential named `name` and wait until its
 * secrets have been fetched (`get_credential_secrets`) and prefilled.
 */
/**
 * Full `textContent` of an element. WebKitGTK's WebDriver `getText` can
 * return "" for a list row whose text sits in truncated children.
 */
export async function textContentOf(el: WebdriverIO.Element): Promise<string> {
  return browser.execute((node: HTMLElement) => node.textContent ?? "", el as unknown as HTMLElement);
}

/**
 * Choose the option whose `data-name` is `name` in the Radix Select behind
 * `triggerSelector`, and confirm the trigger now shows it. A click that
 * lands while the listbox is still opening closes it without selecting;
 * the form would then save with no credential and fail much later, so
 * the pick is verified and retried.
 */
export async function pickCredential(triggerSelector: string, name: string): Promise<void> {
  const trigger = await browser.$(triggerSelector);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await trigger.waitForClickable({ timeout: 10_000 });
    await trigger.click();
    const option = await browser.$(`[role="option"][data-name="${name}"]`);
    await option.waitForClickable({ timeout: 10_000 });
    await option.click();
    const picked = await browser
      .waitUntil(async () => (await textContentOf(trigger)).includes(name), { timeout: 2_000 })
      .catch(() => false);
    if (picked) return;
    // Close a listbox the missed click left open before trying again.
    if (await (await browser.$('[role="listbox"]')).isExisting()) {
      await browser.keys(["Escape"]);
    }
  }
  throw new Error(`Could not select "${name}" in ${triggerSelector}`);
}

export async function openCredentialEditor(name: string): Promise<void> {
  await navigateTo("credentials");
  const row = await browser.$(sel.credentialRowByName(name));
  await row.waitForExist({ timeout: 10_000 });
  // The action strip is hidden until the row is hovered or focused; focus
  // the row (its tabindex comes from the roving-focus hook) to reveal it.
  await browser.execute((el: HTMLElement) => el.focus(), row as unknown as HTMLElement);
  const edit = await row.$(sel.credentialRowEditButton);
  await edit.waitForClickable({ timeout: 10_000 });
  await edit.click();
  const loaded = await browser.$(sel.credentialFormSecretsState("loaded"));
  await loaded.waitForExist({ timeout: 10_000 });
}

export interface DirectConnectionInput {
  name: string;
  host: string;
  port: number;
  credentialName: string;
  tags?: string[];
}

export async function saveConnectionForm(): Promise<void> {
  await clickDialogFooterButton(sel.connectionFormSubmit);
  const form = await browser.$(sel.connectionForm);
  await form.waitForExist({ reverse: true, timeout: 10_000 });
}

export async function createDirectConnection(input: DirectConnectionInput): Promise<void> {
  await navigateTo("connections");
  await click(sel.addConnectionButton);
  await fill(sel.connectionFormName, input.name);
  await click(sel.connectionFormKindDirect);
  await fill(sel.connectionFormHost, input.host);
  await fill(sel.connectionFormPort, String(input.port));
  await pickCredential(sel.connectionFormCredential, input.credentialName);
  if (input.tags && input.tags.length > 0) {
    const tagsInput = await browser.$("#tags");
    await tagsInput.waitForExist({ timeout: 10_000 });
    for (const tag of input.tags) {
      await tagsInput.click();
      await tagsInput.setValue(tag);
      await browser.keys(["Enter"]);
    }
  }
  await saveConnectionForm();
}

/**
 * Open a connection by clicking its visible "Connect" button. The
 * row's outer click handler is wired to onSelect, not onConnect, so
 * doubleClick() on the row won't reliably start a session — the only
 * direct UI affordance is the per-row connect button (always visible,
 * not hidden behind hover state).
 */
/**
 * Rows only exist in the list / tile layouts. A previous spec may have
 * left the persisted layout on "tags", so switch back before looking
 * for a row.
 */
export async function ensureConnectionRowsLayout(): Promise<void> {
  await navigateTo("connections");
  const list = await browser.$(sel.connectionList);
  if (await list.isExisting()) return;
  const toggle = await browser.$(sel.layoutToggleList);
  if (await toggle.isExisting()) {
    await toggle.click();
    await list.waitForExist({ timeout: 10_000 });
  }
}

export async function connectToConnection(name: string): Promise<void> {
  await ensureConnectionRowsLayout();
  const row = await browser.$(sel.connectionRowByName(name));
  await row.waitForExist({ timeout: 10_000 });
  const btn = await row.$('[data-testid^=\"connect-button-\"]');
  await btn.waitForClickable({ timeout: 10_000 });
  await btn.click();
}

/**
 * Read the terminal text. The app exposes every open terminal's buffer via
 * `window.__ssixTerminalText` (see `src/lib/terminalRegistry.ts`) because
 * the WebGL renderer draws to a canvas and leaves no text in the DOM. Fall
 * back to the DOM-renderer rows when the hook is unavailable.
 */
export async function readTerminalText(): Promise<string> {
  const fromBuffer = await browser.execute(
    () => window.__ssixTerminalText?.() ?? null,
  );
  if (typeof fromBuffer === "string") return fromBuffer;
  const rows = await browser.$$(`${sel.terminalContainer} .xterm-rows > div`);
  const parts: string[] = [];
  for (const r of rows) {
    parts.push(await r.getText());
  }
  return parts.join("\n");
}

/** Wait for a FailedTerminal whose backend error contains `needle`. */
export async function waitForFailedTerminalError(needle: string, timeoutMs = 30_000): Promise<string> {
  let lastError = "";
  await browser.waitUntil(
    async () => {
      const failed = await browser.$(sel.failedTerminal);
      if (!(await failed.isExisting())) return false;
      lastError = (await failed.getAttribute("data-error")) ?? "";
      return lastError.includes(needle);
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `No FailedTerminal with error containing ${JSON.stringify(needle)} within ${timeoutMs}ms (last: ${JSON.stringify(lastError)})`,
    },
  );
  return lastError;
}

export async function waitForTerminalContains(needle: string, timeoutMs = 30_000): Promise<void> {
  try {
    await browser.waitUntil(
      async () => (await readTerminalText()).includes(needle),
      {
        timeout: timeoutMs,
        timeoutMsg: `Terminal did not contain ${JSON.stringify(needle)} within ${timeoutMs}ms`,
      },
    );
  } catch {
    // Re-throw with a richer message if a FailedTerminal is mounted —
    // the underlying SSH failure is the real diagnostic.
    const richer = await buildTerminalTimeoutMessage(needle, timeoutMs);
    if (richer) throw new Error(richer);

    const terminalText = await readTerminalText().catch(() => "");
    throw new Error(
      `Terminal did not contain ${JSON.stringify(needle)} within ${timeoutMs}ms.\n` +
        `Visible terminal text:\n${terminalText || "(empty)"}`,
    );
  }
}

async function buildTerminalTimeoutMessage(needle: string, timeoutMs: number): Promise<string | null> {
  try {
    const failed = await browser.$('[data-testid=\"failed-terminal\"]');
    if (await failed.isExisting()) {
      const err = await failed.getAttribute("data-error");
      if (err && err.length > 0) {
        return `Terminal showed FailedTerminal instead of expected ${JSON.stringify(needle)} (backend error): ${err}`;
      }
      return `Terminal stuck on FailedTerminal (still connecting / no error reported) waiting for ${JSON.stringify(needle)} within ${timeoutMs}ms`;
    }
  } catch {
    // ignore
  }
  return null;
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
