/**
 * Spec 19: import from an OpenSSH config.
 *
 * The spec writes its own config in a temp directory and types its path into
 * the panel, since the app and this process share a filesystem both here and
 * in the dockerized runner. It covers:
 *   - a preview that lists what will be created and what is skipped, with
 *     reasons, and saves nothing;
 *   - an import of only the rows left ticked, checked against the stored
 *     connections and credentials;
 *   - two accounts on one server, told apart by their keys;
 *   - a second import of the same file creating nothing;
 *   - a name clash that leaves the existing connection alone;
 *   - a host imported with only a key path really connecting;
 *   - a host that names no key really connecting with the agent;
 *   - imported remote and dynamic forwards really starting;
 *   - an unticked row leaving its name and credential name to the others;
 *   - every row held back when part of the config was not applied;
 *   - unreadable files and hostile lines being reported.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForAppReady } from "../helpers/app.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import {
  click,
  closeAllTabs,
  connectToConnection,
  createDirectConnection,
  createPasswordCredential,
  ensureConnectionRowsLayout,
  fill,
  navigateTo,
  textContentOf,
  typeIntoTerminal,
  waitForTerminalContains,
} from "../helpers/flows.js";
import { startForward, stopForward } from "../helpers/forwards.js";
import { sel } from "../helpers/selectors.js";
import { agentPublicKey } from "../helpers/ssh-agent.js";

interface StoredConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  type: string;
  credential_id?: string;
  gateway_host?: string;
  gateway_port?: number;
  gateway_credential_id?: string;
  local_port?: number;
  remote_port?: number;
  destination_host?: string;
  destination_port?: number;
  proxy_command?: string;
}

interface StoredCredential {
  id: string;
  name: string;
  username: string;
  type: string;
  private_key_path?: string;
  private_key?: string;
}

/** Call a backend command from the webview, to check what was really stored. */
async function backend<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const answer = await browser.execute(
    async (name: string, payload: Record<string, unknown>) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const invoke = (window as any).__TAURI_INTERNALS__.invoke;
      try {
        return { value: await invoke(name, payload) };
      } catch (err) {
        return { error: String(err) };
      }
    },
    command,
    args,
  );
  const { value, error } = answer as { value?: T; error?: string };
  if (error !== undefined) throw new Error(`${command}: ${error}`);
  return value as T;
}

const connections = () => backend<StoredConnection[]>("get_connections");
const credentials = () => backend<StoredCredential[]>("get_credentials");

async function connectionNamed(name: string): Promise<StoredConnection> {
  const found = (await connections()).find((c) => c.name === name);
  if (!found) throw new Error(`No connection named ${name}`);
  return found;
}

async function credentialOf(id: string | undefined): Promise<StoredCredential> {
  const found = (await credentials()).find((c) => c.id === id);
  if (!found) throw new Error(`No credential with id ${id}`);
  return found;
}

async function openImportOf(path: string): Promise<void> {
  await navigateTo("connections");
  await click(sel.importConfigButton);
  await (await browser.$(sel.importDialog)).waitForExist({ timeout: 10_000 });
  await fill(sel.importPath, path);
  await click(sel.importLoad);
}

async function waitForSkip(name: string): Promise<WebdriverIO.Element> {
  const skip = await browser.$(sel.importSkip(name));
  await skip.waitForExist({ timeout: 10_000 });
  return skip;
}

async function expectSkip(name: string, category: string, reason: string): Promise<void> {
  const skip = await waitForSkip(name);
  expect(await skip.getAttribute("data-category")).toBe(category);
  expect(await textContentOf(skip)).toContain(reason);
}

async function waitForItem(name: string): Promise<WebdriverIO.Element> {
  const row = await browser.$(sel.importItem(name));
  await row.waitForExist({ timeout: 10_000 });
  return row;
}

async function isTicked(name: string): Promise<boolean> {
  const row = await waitForItem(name);
  return (await (await row.$(sel.importItemCheckbox)).getAttribute("aria-checked")) === "true";
}

async function toggle(name: string): Promise<void> {
  const row = await waitForItem(name);
  await (await row.$(sel.importItemCheckbox)).click();
}

async function toggleOnIfUnticked(name: string): Promise<void> {
  await waitForItem(name);
  if (!(await isTicked(name))) await toggle(name);
}

async function noticeTexts(): Promise<string[]> {
  const notices = await browser.$$(sel.importNotice);
  return Promise.all(Array.from(notices).map((n) => textContentOf(n)));
}

async function confirmImport(): Promise<void> {
  await click(sel.importConfirm);
  await (await browser.$(sel.importResult)).waitForExist({ timeout: 10_000 });
}

async function closeImport(): Promise<void> {
  await click(sel.importClose);
  await (await browser.$(sel.importDialog)).waitForExist({ reverse: true, timeout: 10_000 });
}

describe("Import from SSH config", () => {
  let dir: string;
  let configPath: string;
  let keyPath: string;

  // Earlier specs already hold connections to server-a as this user, and an
  // import refuses a destination SSIX already has. These hosts reach the same
  // server under another name (a trailing dot, or `localhost`).
  const sameServer = TARGETS.a.host === "127.0.0.1" ? "localhost" : `${TARGETS.a.host}.`;

  before(async () => {
    await waitForServers(["a"]);
    await waitForAppReady();
    dir = mkdtempSync(join(tmpdir(), "ssix-e2e-import-"));
    configPath = join(dir, "config");
    keyPath = join(dir, "id_e2e19");

    // A real key on server-a, so an imported host can really connect. The
    // bootstrap credential goes away again, so the import has to make its own.
    await backend("generate_ssh_key", { input: { storage: "custom_path", path: keyPath } });
    const bootstrap = await backend<StoredCredential>("add_credential", {
      input: {
        name: "cred-19-bootstrap",
        username: TARGETS.a.user,
        type: "ssh_key",
        private_key_path: keyPath,
      },
    });
    await backend("ssh_install_public_key_by_credential", {
      input: {
        credential_id: bootstrap.id,
        host: TARGETS.a.host,
        port: TARGETS.a.sshPort,
        username: TARGETS.a.user,
        password: TARGETS.a.password,
      },
    });
    await backend("delete_credential", { id: bootstrap.id });

    // Existing data the config will run into.
    await createPasswordCredential({ name: "cred-19-pw", username: "dup19", password: "p" });
    await createDirectConnection({
      name: "conn-19-existing",
      host: "10.19.0.1",
      port: 22,
      credentialName: "cred-19-pw",
    });
    const heldKey = await backend<StoredCredential>("add_credential", {
      input: {
        name: "cred-19-key",
        username: "same19",
        type: "ssh_key",
        private_key_path: "/keys/e2e19-same",
      },
    });
    await backend("add_connection", {
      input: {
        name: "conn-19-same-place",
        host: "10.19.0.6",
        port: 22,
        credential_id: heldKey.id,
        type: "direct",
      },
    });

    const extra = join(dir, "extra.conf");
    writeFileSync(extra, "Host e2e19-included\n  HostName 10.19.0.20\n  User inc19\n");
    writeFileSync(
      configPath,
      [
        "# Written by spec 19",
        `Include ${extra}`,
        "",
        "Host e2e19-direct e2e19-direct-alias",
        `  HostName ${sameServer}`,
        `  Port ${TARGETS.a.sshPort}`,
        `  User ${TARGETS.a.user}`,
        `  IdentityFile ${keyPath}`,
        "  LocalForward 23619 server-c:22",
        "  RemoteForward 23620 localhost:22",
        "  DynamicForward 23621",
        "",
        "Host e2e19-bastion",
        "  HostName 10.19.0.2",
        "  Port 2222",
        "  User ops19",
        "",
        "Host e2e19-jumped",
        "  HostName server-c",
        "  User userc",
        "  ProxyJump e2e19-bastion",
        "",
        "Host e2e19-proxied",
        "  HostName 10.19.0.3",
        "  User prox19",
        "  ProxyCommand nc -w 1 %h %p",
        "",
        "Host e2e19-left-out",
        "  HostName 10.19.0.4",
        "  User left19",
        "",
        "Host e2e19-two-hops",
        "  User hops19",
        "  ProxyJump e2e19-a,e2e19-b",
        "",
        "Host e2e19-bad-port",
        "  User port19",
        "  Port 99999",
        "",
        "Host e2e19-bad-token",
        "  User tok19",
        "  ProxyCommand nc %C",
        "",
        // What a connection SSIX already has does, under a new name.
        "Host e2e19-same-place",
        "  HostName 10.19.0.6",
        "  User same19",
        "  IdentityFile /keys/e2e19-same",
        "",
        // The server and user of a connection SSIX has, signing in another way.
        "Host e2e19-other-sign-in",
        "  HostName 10.19.0.1",
        "  User dup19",
        "",
        // Two accounts on one server, told apart only by their keys.
        "Host e2e19-acct-work",
        "  HostName 10.19.0.7",
        "  User acct19",
        "  IdentityFile /keys/e2e19-work",
        "",
        "Host e2e19-acct-personal",
        "  HostName 10.19.0.7",
        "  User acct19",
        "  IdentityFile /keys/e2e19-personal",
        "",
        // The name of a connection SSIX already has, somewhere else.
        "Host conn-19-existing",
        "  HostName 10.19.0.99",
        "  User clash19",
        "",
        "Host e2e19-*.internal",
        "  Port 2200",
        "",
      ].join("\n"),
    );
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows what will be created and what is skipped, and saves nothing", async () => {
    const connectionsBefore = await connections();
    const credentialsBefore = await credentials();

    await openImportOf(configPath);
    for (const name of [
      "e2e19-direct",
      "e2e19-direct (-L 23619)",
      "e2e19-direct (-R 23620)",
      "e2e19-direct (-D 23621)",
      "e2e19-bastion",
      "e2e19-jumped",
      "e2e19-proxied",
      "e2e19-left-out",
      "e2e19-included",
      "e2e19-other-sign-in",
      "e2e19-acct-work",
      "e2e19-acct-personal",
    ]) {
      await waitForItem(name);
    }
    expect(await isTicked("e2e19-direct")).toBe(true);
    expect(await isTicked("e2e19-acct-work")).toBe(true);
    expect(await isTicked("e2e19-acct-personal")).toBe(true);

    // A second alias of one destination is offered, but starts unticked.
    expect(await isTicked("e2e19-direct-alias")).toBe(false);
    expect(await textContentOf(await waitForItem("e2e19-direct-alias"))).toContain(
      "Same destination as 'e2e19-direct'",
    );

    const proxied = await browser.$(sel.importItem("e2e19-proxied"));
    expect(await textContentOf(proxied)).toContain("nc -w 1 %h %p");

    await expectSkip("e2e19-two-hops", "unsupported", "2 hops");
    await expectSkip("e2e19-bad-port", "invalid", "99999");
    await expectSkip("e2e19-bad-token", "unsupported", "%C");
    await expectSkip("e2e19-same-place", "already_imported", "conn-19-same-place");
    await expectSkip("conn-19-existing", "name_clash", "already exists");
    await expectSkip("e2e19-*.internal", "pattern", "not a single host");
    expect(await (await browser.$(sel.importItem("conn-19-existing"))).isExisting()).toBe(false);

    expect(await textContentOf(await browser.$(sel.importFiles))).toContain("extra.conf");

    await closeImport();
    expect((await connections()).length).toBe(connectionsBefore.length);
    expect((await credentials()).length).toBe(credentialsBefore.length);
  });

  it("imports only the rows left ticked, as the config describes them", async () => {
    await openImportOf(configPath);
    await toggle("e2e19-left-out");
    await confirmImport();

    // The preview reloads: what was imported now shows as imported.
    await expectSkip("e2e19-direct", "already_imported", "Already in SSIX");
    await waitForItem("e2e19-left-out");
    await closeImport();

    const names = (await connections()).map((c) => c.name);
    expect(names).toContain("e2e19-included");
    expect(names).not.toContain("e2e19-left-out");
    expect(names).not.toContain("e2e19-direct-alias");

    // Both accounts on the one server, each with its own key.
    const accountKey = async (name: string) =>
      (await credentialOf((await connectionNamed(name)).credential_id)).private_key_path;
    expect(await accountKey("e2e19-acct-work")).toBe("/keys/e2e19-work");
    expect(await accountKey("e2e19-acct-personal")).toBe("/keys/e2e19-personal");

    const direct = await connectionNamed("e2e19-direct");
    expect(direct.type).toBe("direct");
    expect(direct.host).toBe(sameServer);
    expect(direct.port).toBe(TARGETS.a.sshPort);
    const key = await credentialOf(direct.credential_id);
    expect(key.type).toBe("ssh_key");
    expect(key.username).toBe(TARGETS.a.user);
    expect(key.private_key_path).toBe(keyPath);
    // A path and nothing else: no key contents and nothing in the secrets file.
    expect(key.private_key).toBeUndefined();
    expect(await backend("get_credential_secrets", { id: key.id })).toEqual({});

    const local = await connectionNamed("e2e19-direct (-L 23619)");
    expect(local.type).toBe("port_forward");
    expect(local.gateway_host).toBe(sameServer);
    expect(local.gateway_credential_id).toBe(key.id);
    expect(local.local_port).toBe(23619);
    expect(local.destination_host).toBe("server-c");
    expect(local.destination_port).toBe(22);

    const remote = await connectionNamed("e2e19-direct (-R 23620)");
    expect(remote.type).toBe("remote_forward");
    expect(remote.remote_port).toBe(23620);
    expect(remote.destination_host).toBe("localhost");

    const dynamic = await connectionNamed("e2e19-direct (-D 23621)");
    expect(dynamic.type).toBe("dynamic_forward");
    expect(dynamic.local_port).toBe(23621);

    const jumped = await connectionNamed("e2e19-jumped");
    expect(jumped.type).toBe("jump_shell");
    expect(jumped.gateway_host).toBe("10.19.0.2");
    expect(jumped.gateway_port).toBe(2222);
    expect(jumped.destination_host).toBe("server-c");
    expect((await credentialOf(jumped.gateway_credential_id)).username).toBe("ops19");
    expect((await credentialOf(jumped.credential_id)).username).toBe("userc");

    const proxied = await connectionNamed("e2e19-proxied");
    expect(proxied.proxy_command).toBe("nc -w 1 %h %p");

    // A host with no IdentityFile signs in with the agent.
    const agent = await credentialOf((await connectionNamed("e2e19-included")).credential_id);
    expect(agent.type).toBe("agent");
    expect(agent.username).toBe("inc19");

    await ensureConnectionRowsLayout();
    await (await browser.$(sel.connectionRowByName("e2e19-direct"))).waitForExist({
      timeout: 10_000,
    });
    await navigateTo("forwards");
    await (await browser.$(sel.forwardRowByName("e2e19-direct (-L 23619)"))).waitForExist({
      timeout: 10_000,
    });
  });

  it("creates nothing on a second import of the same file", async () => {
    const connectionsBefore = await connections();
    const credentialsBefore = await credentials();

    await openImportOf(configPath);
    await waitForItem("e2e19-left-out");
    expect((await browser.$$(sel.importItems)).length).toBe(1);
    await expectSkip("e2e19-acct-work", "already_imported", "Already in SSIX");
    await expectSkip("e2e19-acct-personal", "already_imported", "Already in SSIX");
    await expectSkip("e2e19-direct-alias", "already_imported", "e2e19-direct");
    await expectSkip("e2e19-direct", "already_imported", "Already in SSIX");
    await expectSkip("e2e19-direct (-L 23619)", "already_imported", "Already in SSIX");
    await expectSkip("e2e19-jumped", "already_imported", "Already in SSIX");
    await closeImport();

    expect((await connections()).length).toBe(connectionsBefore.length);
    expect((await credentials()).length).toBe(credentialsBefore.length);
  });

  it("never overwrites a connection whose name clashes", async () => {
    const existing = await connectionNamed("conn-19-existing");
    expect(existing.host).toBe("10.19.0.1");
    expect(existing.type).toBe("direct");
    expect((await credentialOf(existing.credential_id)).name).toBe("cred-19-pw");
  });

  it("connects with the imported key path", async () => {
    await navigateTo("connections");
    await connectToConnection("e2e19-direct");
    // Alpine ash prompt: `<host>:~$` (see spec 03 for context).
    await waitForTerminalContains("server-a:~$", 30_000);
    await navigateTo("connections");
  });

  it("connects with the agent when a host names no key", async () => {
    // The shell the last test opened puts the agent's key on server-a.
    await click(sel.navTerminals);
    await typeIntoTerminal(
      `umask 077; echo '${agentPublicKey()}' >> ~/.ssh/authorized_keys; echo ssix-19-$((40+2))\n`,
    );
    await waitForTerminalContains("ssix-19-42", 15_000);
    await closeAllTabs();

    const agentConfig = join(dir, "config-agent");
    writeFileSync(
      agentConfig,
      ["Host e2e19-agent", `  HostName ${sameServer}`, `  Port ${TARGETS.a.sshPort}`, `  User ${TARGETS.a.user}`, ""].join("\n"),
    );
    await openImportOf(agentConfig);
    await toggleOnIfUnticked("e2e19-agent");
    await confirmImport();
    await expectSkip("e2e19-agent", "already_imported", "Already in SSIX");
    await closeImport();
    const agent = await connectionNamed("e2e19-agent");
    expect((await credentialOf(agent.credential_id)).type).toBe("agent");

    await navigateTo("connections");
    await connectToConnection("e2e19-agent");
    // With every tab closed, this prompt can only be the agent session's.
    await waitForTerminalContains("server-a:~$", 30_000);
    await closeAllTabs();
    await navigateTo("connections");
  });

  it("starts the remote and dynamic forwards it imported", async () => {
    for (const name of ["e2e19-direct (-R 23620)", "e2e19-direct (-D 23621)"]) {
      await startForward(name);
      await stopForward(name);
    }
    await navigateTo("connections");
  });

  it("lets an unticked row leave its name and credential name to the others", async () => {
    const picks = join(dir, "picks");
    writeFileSync(
      picks,
      [
        "Host e2e19-prod e2e19-prod-alt",
        "  HostName 10.19.0.8",
        "  User pick19",
        "  IdentityFile /keys/e2e19-pick",
        "",
        "Host e2e19-key-a",
        "  HostName 10.19.0.9",
        "  User name19",
        "  IdentityFile /keys/a/id_e2e19name",
        "",
        "Host e2e19-key-b",
        "  HostName 10.19.0.10",
        "  User name19",
        "  IdentityFile /keys/b/id_e2e19name",
        "",
      ].join("\n"),
    );

    await openImportOf(picks);
    expect(await isTicked("e2e19-prod")).toBe(true);
    expect(await isTicked("e2e19-prod-alt")).toBe(false);
    await toggle("e2e19-prod");
    await toggle("e2e19-prod-alt");
    await toggle("e2e19-key-a");
    await confirmImport();
    await closeImport();

    const names = (await connections()).map((c) => c.name);
    expect(names).toContain("e2e19-prod-alt");
    expect(names).toContain("e2e19-key-b");
    expect(names).not.toContain("e2e19-prod");
    expect(names).not.toContain("e2e19-key-a");

    // /keys/a was left out, so /keys/b has the plain name and no number.
    const key = await credentialOf((await connectionNamed("e2e19-key-b")).credential_id);
    expect(key.name).toBe("name19@id_e2e19name");
    expect(key.private_key_path).toBe("/keys/b/id_e2e19name");
  });

  it("holds back every row when part of the config was not applied", async () => {
    const partial = join(dir, "partial");
    writeFileSync(
      partial,
      [
        "Host e2e19-held-a",
        "  HostName 10.19.0.11",
        "  User held19",
        "",
        "Host e2e19-held-b",
        "  HostName 10.19.0.12",
        "  User held19",
        "",
        // ssh would go through a bastion for this host; the import cannot know.
        "Match host e2e19-held-a",
        "  ProxyJump e2e19-bastion",
        "",
      ].join("\n"),
    );

    await openImportOf(partial);
    for (const name of ["e2e19-held-a", "e2e19-held-b"]) {
      expect(await isTicked(name)).toBe(false);
      expect(await textContentOf(await waitForItem(name))).toContain("was not applied");
    }
    expect((await noticeTexts()).some((text) => text.includes("Match block skipped"))).toBe(true);
    expect(await (await browser.$(sel.importConfirm)).isEnabled()).toBe(false);

    // It stays the user's choice, row by row.
    await toggle("e2e19-held-b");
    await confirmImport();
    await closeImport();
    const names = (await connections()).map((c) => c.name);
    expect(names).toContain("e2e19-held-b");
    expect(names).not.toContain("e2e19-held-a");
  });

  it("reports a missing file and offers nothing to import", async () => {
    const missing = join(dir, "no-such-config");
    await openImportOf(missing);
    const banner = await browser.$(sel.importLoadError);
    await banner.waitForExist({ timeout: 10_000 });
    expect(await textContentOf(banner)).toContain("does not exist");
    expect(await (await browser.$(sel.importConfirm)).isEnabled()).toBe(false);
    await closeImport();
  });

  it("reports hostile lines instead of failing", async () => {
    const hostile = join(dir, "hostile");
    writeFileSync(
      hostile,
      [
        `Host e2e19-long\n  User ${"x".repeat(6000)}`,
        'Host e2e19-quote\n  User "unbalanced',
        `Host ${"y".repeat(5000)}\n  User lost`,
        `Include ${hostile}`,
        "Host e2e19-survivor\n  HostName 10.19.0.50\n  User ok19",
        "",
      ].join("\n"),
    );

    await openImportOf(hostile);
    await waitForItem("e2e19-survivor");
    expect((await browser.$$(sel.importItems)).length).toBe(1);
    // The Host line and the Include it could not read could change any host.
    expect(await isTicked("e2e19-survivor")).toBe(false);
    await expectSkip("e2e19-long", "invalid", "longer than 4096");
    await expectSkip("e2e19-quote", "invalid", "unbalanced quote");

    const texts = await noticeTexts();
    expect(texts.some((text) => text.includes("include itself"))).toBe(true);
    expect(texts.some((text) => text.includes("Host line ignored"))).toBe(true);
    await closeImport();
  });
});
