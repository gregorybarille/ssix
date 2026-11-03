/**
 * Spec 16: remote (`ssh -R`) and dynamic (`ssh -D`) forwards, and forwards
 * ending when they should.
 *
 * The tests run in order and build on each other: the SOCKS proxy of the
 * dynamic forward is also how the test runner reaches the loopback of
 * server-a, which is the only place a remote forward listens.
 *
 *   runner -> SOCKS port -> server-a -> 127.0.0.1:REMOTE_PORT -> SSIX -> echo server
 *
 * The runner and the app share a machine in both CI and `npm run e2e`, so
 * the echo server and the relay listen on its loopback and are reached from
 * the app by 127.0.0.1. What server-a dials is named from inside its network.
 *
 * Connections to an sshd that never authenticate count towards its
 * `PerSourcePenalties`, so this spec makes only a handful of them.
 */
import { once } from "node:events";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { waitForAppReady } from "../helpers/app.js";
import { TARGETS, waitForServers } from "../helpers/docker.js";
import {
  click,
  clickDialogFooterButton,
  createPasswordCredential,
  fill,
  navigateTo,
  pickOption,
  saveConnectionForm,
  textContentOf,
} from "../helpers/flows.js";
import { clickStart, rowOf, startForward, stopForward, waitForRow, waitForStatus } from "../helpers/forwards.js";
import { sel } from "../helpers/selectors.js";

const CREDENTIAL = "cred-16-a";
const SOCKS_PORT = 23661;
/** On server-a, not on this machine. */
const REMOTE_PORT = 23662;
const LOCAL_PORT = 23663;
const RELAYED_SOCKS_PORT = 23664;
const DELETED_SOCKS_PORT = 23665;
const BIND_PORT = 23666;
const TRAFFIC_PORT = 23667;

const CMD_CONNECT = 1;
const CMD_BIND = 2;
const CMD_UDP_ASSOCIATE = 3;
const REPLY_SUCCEEDED = 0;
const REPLY_CONNECTION_REFUSED = 5;
const REPLY_COMMAND_NOT_SUPPORTED = 7;
const REPLY_ADDRESS_TYPE_NOT_SUPPORTED = 8;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Client {
  socket: Socket;
  take: (count: number, timeoutMs?: number) => Promise<Buffer>;
  waitForClose: (timeoutMs: number) => Promise<void>;
}

/** A TCP connection whose bytes can be awaited in the sizes a protocol needs. */
async function openClient(port: number, host = "127.0.0.1"): Promise<Client> {
  const socket = connect({ host, port });
  let buffered = Buffer.alloc(0);
  let closed = false;
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk as Buffer]);
  });
  socket.on("close", () => {
    closed = true;
  });
  await once(socket, "connect");
  socket.on("error", () => {
    closed = true;
  });
  return {
    socket,
    take: async (count, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (buffered.length < count) {
        if (closed) throw new Error(`closed after ${buffered.length} of ${count} bytes`);
        if (Date.now() > deadline) {
          throw new Error(`timed out after ${buffered.length} of ${count} bytes`);
        }
        await sleep(20);
      }
      const taken = buffered.subarray(0, count);
      buffered = buffered.subarray(count);
      return taken;
    },
    waitForClose: async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (!closed) {
        if (Date.now() > deadline) throw new Error(`still open after ${timeoutMs} ms`);
        await sleep(20);
      }
    },
  };
}

const portBytes = (port: number) => [port >> 8, port & 0xff];
const ipv4 = (octets: number[], port: number) => Buffer.from([1, ...octets, ...portBytes(port)]);
const ipv6Loopback = (port: number) =>
  Buffer.from([4, ...new Array<number>(15).fill(0), 1, ...portBytes(port)]);
const domain = (name: string, port: number) =>
  Buffer.concat([Buffer.from([3, name.length]), Buffer.from(name), Buffer.from(portBytes(port))]);

/** Negotiate "no authentication" and send one request; the proxy's reply code and the connection. */
async function socksRequest(
  port: number,
  command: number,
  address: Buffer,
): Promise<{ reply: number; client: Client }> {
  const client = await openClient(port);
  client.socket.write(Buffer.from([5, 1, 0]));
  expect([...(await client.take(2))]).toEqual([5, 0]);
  client.socket.write(Buffer.concat([Buffer.from([5, command, 0]), address]));
  const head = await client.take(4);
  expect(head[0]).toBe(5);
  // The bound address that ends every reply; SSIX always sends an IPv4 one.
  expect(head[3]).toBe(1);
  await client.take(4 + 2);
  return { reply: head[1], client };
}

async function socksReply(port: number, command: number, address: Buffer): Promise<number> {
  const { reply, client } = await socksRequest(port, command, address);
  client.socket.destroy();
  return reply;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(3_000);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function listenOnLoopback(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

function echoServer(): Server {
  return createServer((socket) => {
    socket.on("error", () => {});
    socket.pipe(socket);
  });
}

/** Passes TCP on to an address; `dropAll` is what a dying network does to a session. */
function relayTo(host: string, port: number): { server: Server; dropAll: () => void } {
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    return socket;
  };
  const server = createServer((incoming) => {
    const outgoing = track(connect({ host, port }));
    track(incoming);
    incoming.pipe(outgoing);
    outgoing.pipe(incoming);
  });
  return {
    server,
    dropAll: () => {
      for (const socket of sockets) socket.destroy();
    },
  };
}

interface ForwardInput {
  name: string;
  kind: string;
  portField: string;
  port: number;
  /** The SSH server; server-a unless the test puts something in front of it. */
  server?: { host: string; port: number };
  target?: { host: string; port: number };
}

async function fillForwardForm(input: ForwardInput): Promise<void> {
  const server = input.server ?? { host: TARGETS.a.host, port: TARGETS.a.sshPort };
  await navigateTo("connections");
  await click(sel.addConnectionButton);
  await fill(sel.connectionFormName, input.name);
  await pickOption(sel.connectionFormType, input.kind);
  await fill(sel.connectionFormHopHost, server.host);
  await fill(sel.connectionFormHopPort, String(server.port));
  await pickOption(sel.connectionFormHopCredential, CREDENTIAL);
  if (input.target) {
    await fill(sel.connectionFormTargetHost, input.target.host);
    await fill(sel.connectionFormTargetPort, String(input.target.port));
  }
  await fill(input.portField, String(input.port));
}

async function createForward(input: ForwardInput): Promise<void> {
  await fillForwardForm(input);
  await saveConnectionForm();
}

async function statusLabel(name: string): Promise<string | null> {
  const dot = await (await rowOf(name)).$('[data-testid^="forward-status-"]');
  return dot.getAttribute("aria-label");
}

const waitUntilRefused = (host: string, port: number, what: string) =>
  browser.waitUntil(async () => !(await canConnect(host, port)), {
    timeout: 10_000,
    timeoutMsg: `${what} is still accepting connections`,
  });

describe("Remote and dynamic forwards", () => {
  const echo = echoServer();
  const relay = relayTo(TARGETS.a.probeHost, TARGETS.a.probePort);
  let echoPort = 0;
  let relayPort = 0;

  before(async () => {
    await waitForServers(["a"]);
    await waitForAppReady();
    await createPasswordCredential({
      name: CREDENTIAL,
      username: TARGETS.a.user,
      password: TARGETS.a.password,
    });
    echoPort = await listenOnLoopback(echo);
    relayPort = await listenOnLoopback(relay.server);
  });

  after(() => {
    relay.dropAll();
    relay.server.close();
    echo.close();
  });

  it("reports a bad port beside its input", async () => {
    await fillForwardForm({
      name: "forward-16-remote",
      kind: sel.connectionFormKindRemoteForward,
      portField: sel.connectionFormRemotePort,
      port: 70000,
      target: { host: "127.0.0.1", port: echoPort },
    });

    await clickDialogFooterButton(sel.connectionFormSubmit);
    const input = await browser.$(sel.connectionFormRemotePort);
    await browser.waitUntil(async () => (await input.getAttribute("aria-invalid")) === "true", {
      timeout: 5_000,
      timeoutMsg: "The remote port input never reported the bad port",
    });
    expect(await (await browser.$(sel.connectionForm)).isExisting()).toBe(true);

    await fill(sel.connectionFormRemotePort, String(REMOTE_PORT));
    await saveConnectionForm();
  });

  it("carries SOCKS clients to what they ask for, resolved by the SSH server", async () => {
    await createForward({
      name: "forward-16-socks",
      kind: sel.connectionFormKindDynamicForward,
      portField: sel.connectionFormSocksPort,
      port: SOCKS_PORT,
    });
    await startForward("forward-16-socks");

    // server-c is on a private network only server-a can see.
    const byName = await socksRequest(SOCKS_PORT, CMD_CONNECT, domain("server-c", 22));
    expect(byName.reply).toBe(REPLY_SUCCEEDED);
    expect((await byName.client.take(7)).toString()).toBe("SSH-2.0");
    byName.client.socket.destroy();

    const byAddress = await socksRequest(SOCKS_PORT, CMD_CONNECT, ipv4([127, 0, 0, 1], 22));
    expect(byAddress.reply).toBe(REPLY_SUCCEEDED);
    expect((await byAddress.client.take(7)).toString()).toBe("SSH-2.0");
    byAddress.client.socket.destroy();

    // Whether the container has IPv6 is not this test's business, only that
    // the address type was understood.
    const v6 = await socksReply(SOCKS_PORT, CMD_CONNECT, ipv6Loopback(22));
    expect(v6).not.toBe(REPLY_ADDRESS_TYPE_NOT_SUPPORTED);
  });

  it("answers what a SOCKS proxy must refuse with the right replies", async () => {
    expect(await socksReply(SOCKS_PORT, CMD_CONNECT, ipv4([127, 0, 0, 1], 1))).toBe(
      REPLY_CONNECTION_REFUSED,
    );
    const address = ipv4([127, 0, 0, 1], 22);
    expect(await socksReply(SOCKS_PORT, CMD_BIND, address)).toBe(REPLY_COMMAND_NOT_SUPPORTED);
    expect(await socksReply(SOCKS_PORT, CMD_UDP_ASSOCIATE, address)).toBe(
      REPLY_COMMAND_NOT_SUPPORTED,
    );

    // Offering only username/password leaves nothing acceptable.
    const passwordOnly = await openClient(SOCKS_PORT);
    passwordOnly.socket.write(Buffer.from([5, 1, 2]));
    expect([...(await passwordOnly.take(2))]).toEqual([5, 0xff]);
    passwordOnly.socket.destroy();
  });

  it("does not expose the SOCKS port beyond this machine", async () => {
    const external = Object.values(networkInterfaces())
      .flat()
      .find((address) => address && !address.internal && address.family === "IPv4");
    expect(external).toBeDefined();
    expect(await canConnect(external!.address, SOCKS_PORT)).toBe(false);
    expect(await canConnect("127.0.0.1", SOCKS_PORT)).toBe(true);
  });

  it("carries connections to the server's port back to the local target", async () => {
    await startForward("forward-16-remote");

    const { reply, client } = await socksRequest(
      SOCKS_PORT,
      CMD_CONNECT,
      ipv4([127, 0, 0, 1], REMOTE_PORT),
    );
    expect(reply).toBe(REPLY_SUCCEEDED);
    client.socket.write("through the server and back");
    expect((await client.take(27)).toString()).toBe("through the server and back");

    // The row hears about its client from the backend's status events.
    await waitForRow("forward-16-remote", "data-clients", (v) => v === "1", "1");
    client.socket.destroy();
    await waitForRow("forward-16-remote", "data-clients", (v) => v === "0", "0");
  });

  it("listens only on the server's loopback, like ssh -R", async () => {
    // From inside server-a its own name is its address on the network.
    expect(await socksReply(SOCKS_PORT, CMD_CONNECT, domain("server-a", REMOTE_PORT))).toBe(
      REPLY_CONNECTION_REFUSED,
    );
  });

  it("shows why the server refused a port that is taken, and keeps the running forward", async () => {
    await createForward({
      name: "forward-16-remote-taken",
      kind: sel.connectionFormKindRemoteForward,
      portField: sel.connectionFormRemotePort,
      port: REMOTE_PORT,
      target: { host: "127.0.0.1", port: echoPort },
    });
    await clickStart("forward-16-remote-taken");
    await waitForStatus("forward-16-remote-taken", "error");
    expect(await statusLabel("forward-16-remote-taken")).toContain("Error connecting");

    const row = await rowOf("forward-16-remote-taken");
    await (await row.$("button[aria-expanded]")).click();
    expect(await textContentOf(row)).toContain("refused to listen on port");

    await waitForStatus("forward-16-remote", "connected");
  });

  it("drops a remote forward's clients and closes the server's port when stopped", async () => {
    const { reply, client } = await socksRequest(
      SOCKS_PORT,
      CMD_CONNECT,
      ipv4([127, 0, 0, 1], REMOTE_PORT),
    );
    expect(reply).toBe(REPLY_SUCCEEDED);
    client.socket.write("ping");
    expect((await client.take(4)).toString()).toBe("ping");

    await stopForward("forward-16-remote");
    await client.waitForClose(10_000);

    await browser.waitUntil(
      async () =>
        (await socksReply(SOCKS_PORT, CMD_CONNECT, ipv4([127, 0, 0, 1], REMOTE_PORT))) ===
        REPLY_CONNECTION_REFUSED,
      { timeout: 10_000, timeoutMsg: "The server's port stayed open after the stop" },
    );
  });

  it("drops a dynamic forward's clients and closes its port when stopped", async () => {
    const { reply, client } = await socksRequest(SOCKS_PORT, CMD_CONNECT, domain("server-c", 22));
    expect(reply).toBe(REPLY_SUCCEEDED);
    expect((await client.take(7)).toString()).toBe("SSH-2.0");

    await stopForward("forward-16-socks");
    await client.waitForClose(10_000);
    await waitUntilRefused("127.0.0.1", SOCKS_PORT, "The SOCKS port");
  });

  it("drops a local forward's clients and closes its port when stopped", async () => {
    await createForward({
      name: "forward-16-local",
      kind: sel.connectionFormKindLocalForward,
      portField: sel.connectionFormLocalPort,
      port: LOCAL_PORT,
      target: { host: "server-c", port: 22 },
    });
    await startForward("forward-16-local");

    const client = await openClient(LOCAL_PORT);
    expect((await client.take(7)).toString()).toBe("SSH-2.0");
    await waitForRow("forward-16-local", "data-clients", (v) => v === "1", "1");

    await stopForward("forward-16-local");
    await client.waitForClose(10_000);
    await waitUntilRefused("127.0.0.1", LOCAL_PORT, "The local port");
  });

  it("counts what a forward carries each way, and shows the speed", async () => {
    await createForward({
      name: "forward-16-traffic",
      kind: sel.connectionFormKindLocalForward,
      portField: sel.connectionFormLocalPort,
      port: TRAFFIC_PORT,
      target: { host: "server-c", port: 22 },
    });
    await startForward("forward-16-traffic");
    const row = await rowOf("forward-16-traffic");
    expect(await row.getAttribute("data-bytes-sent")).toBe("0");
    expect(await row.getAttribute("data-bytes-received")).toBe("0");
    expect(await textContentOf(row)).toContain("Up 0 B/s, down 0 B/s");

    // sshd speaks first, so this much came back through the forward.
    const client = await openClient(TRAFFIC_PORT);
    expect((await client.take(7)).toString()).toBe("SSH-2.0");
    await waitForRow("forward-16-traffic", "data-bytes-received", (v) => Number(v) >= 7, "at least 7");
    const hello = "SSH-2.0-spec16\r\n";
    client.socket.write(hello);
    await waitForRow(
      "forward-16-traffic",
      "data-bytes-sent",
      (v) => Number(v) >= hello.length,
      `at least ${hello.length}`,
    );

    await stopForward("forward-16-traffic");
    await client.waitForClose(10_000);
  });

  it("listens on the address it is told to, and warns about one others can reach", async () => {
    await fillForwardForm({
      name: "forward-16-bind",
      kind: sel.connectionFormKindLocalForward,
      portField: sel.connectionFormLocalPort,
      port: BIND_PORT,
      target: { host: "server-c", port: 22 },
    });
    const warning = await browser.$(sel.connectionFormBindWarning);
    expect(await warning.isExisting()).toBe(false);
    await fill(sel.connectionFormBindAddress, "0.0.0.0");
    await warning.waitForDisplayed({ timeoutMsg: "No warning for an address others can reach" });

    await fill(sel.connectionFormBindAddress, "not-an-address");
    await clickDialogFooterButton(sel.connectionFormSubmit);
    const input = await browser.$(sel.connectionFormBindAddress);
    await browser.waitUntil(async () => (await input.getAttribute("aria-invalid")) === "true", {
      timeout: 5_000,
      timeoutMsg: "The bind address input never reported the bad address",
    });

    // All of 127/8 is loopback on Linux, so this is another address on this
    // machine that the default would not answer on.
    await fill(sel.connectionFormBindAddress, "127.0.0.2");
    expect(await warning.isExisting()).toBe(false);
    await saveConnectionForm();
    await startForward("forward-16-bind");
    expect(await textContentOf(await rowOf("forward-16-bind"))).toContain(
      `127.0.0.2:${BIND_PORT}`,
    );

    const client = await openClient(BIND_PORT, "127.0.0.2");
    expect((await client.take(7)).toString()).toBe("SSH-2.0");
    expect(await canConnect("127.0.0.1", BIND_PORT)).toBe(false);

    await stopForward("forward-16-bind");
    await client.waitForClose(10_000);
    await waitUntilRefused("127.0.0.2", BIND_PORT, "The bound port");
  });

  it("shows an idle forward as lost when its session dies, and starts again", async () => {
    await createForward({
      name: "forward-16-relayed",
      kind: sel.connectionFormKindDynamicForward,
      portField: sel.connectionFormSocksPort,
      port: RELAYED_SOCKS_PORT,
      server: { host: "127.0.0.1", port: relayPort },
    });
    await startForward("forward-16-relayed");
    expect(await socksReply(RELAYED_SOCKS_PORT, CMD_CONNECT, ipv4([127, 0, 0, 1], 1))).toBe(
      REPLY_CONNECTION_REFUSED,
    );

    relay.dropAll();

    await waitForStatus("forward-16-relayed", "error");
    expect(await statusLabel("forward-16-relayed")).toContain("Connection lost");
    await waitUntilRefused("127.0.0.1", RELAYED_SOCKS_PORT, "The lost forward's port");

    await startForward("forward-16-relayed");
    expect(await socksReply(RELAYED_SOCKS_PORT, CMD_CONNECT, ipv4([127, 0, 0, 1], 1))).toBe(
      REPLY_CONNECTION_REFUSED,
    );
    await stopForward("forward-16-relayed");
  });

  it("starts a stopped forward again straight away, its port given back first", async () => {
    await startForward("forward-16-socks");
    for (let round = 0; round < 3; round += 1) {
      await stopForward("forward-16-socks");
      await startForward("forward-16-socks");
      expect(await socksReply(SOCKS_PORT, CMD_CONNECT, ipv4([127, 0, 0, 1], 1))).toBe(
        REPLY_CONNECTION_REFUSED,
      );
    }

    await startForward("forward-16-remote");
    await stopForward("forward-16-remote");
    await startForward("forward-16-remote");
    const { reply, client } = await socksRequest(
      SOCKS_PORT,
      CMD_CONNECT,
      ipv4([127, 0, 0, 1], REMOTE_PORT),
    );
    expect(reply).toBe(REPLY_SUCCEEDED);
    client.socket.write("again");
    expect((await client.take(5)).toString()).toBe("again");
    client.socket.destroy();

    await stopForward("forward-16-remote");
    await stopForward("forward-16-socks");
  });

  it("stops a running forward that is deleted", async () => {
    await createForward({
      name: "forward-16-deleted",
      kind: sel.connectionFormKindDynamicForward,
      portField: sel.connectionFormSocksPort,
      port: DELETED_SOCKS_PORT,
    });
    await startForward("forward-16-deleted");
    expect(await canConnect("127.0.0.1", DELETED_SOCKS_PORT)).toBe(true);

    const row = await rowOf("forward-16-deleted");
    await (await row.$("button[aria-expanded]")).click();
    const remove = await row.$('[data-testid^="forward-delete-"]');
    await remove.waitForClickable({ timeout: 10_000 });
    await remove.click();
    await clickDialogFooterButton(sel.confirmDeleteConnectionConfirm);

    // Looked up afresh on each try: a lookup that lands mid-removal throws a stale element error.
    await browser.waitUntil(async () => !(await (await rowOf("forward-16-deleted")).isExisting()), {
      timeout: 10_000,
      timeoutMsg: "The deleted forward's row stayed in the list",
    });
    await waitUntilRefused("127.0.0.1", DELETED_SOCKS_PORT, "The deleted forward's port");
  });
});
