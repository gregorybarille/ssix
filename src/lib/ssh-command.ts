import type { Connection, Credential } from "@/types";

/**
 * Build a portable `ssh` CLI command for the given connection.
 *
 * The shape mirrors what the `ssh2` backend dials:
 *
 * - `direct`: `ssh [-i KEY] [-p PORT] user@host`
 * - `jump_shell` (jump host): `ssh -J jumpUser@jumphost[:port] [-i KEY] [-p PORT] user@target`
 * - `port_forward` (local forward): `ssh -L LOCAL:REMOTE:REMOTE_PORT [-i KEY] user@server[:port]`
 *   (the SSH server is the host you actually connect to; it reaches the
 *   remote host on your behalf.)
 *
 * The username is resolved from the target credential when present, and
 * falls back to the SSH server's credential for `port_forward`. If no credential
 * matches (e.g. inline auth that hasn't been saved yet), the user portion is
 * omitted and the user is expected to fill it in.
 *
 * A proxy command becomes `-o ProxyCommand=…` on the host it reaches (the
 * first hop). Behind a jump host that hop is the jump host, which `-J`
 * cannot give a proxy, so the jump is spelled out as a nested
 * `ProxyCommand=ssh -W %h:%p …` instead.
 *
 * Default port `22` is suppressed for readability. Identity files are
 * included only when the credential stores a filesystem path; inline keys
 * cannot be referenced from a CLI command and are skipped.
 *
 * The returned string is shell-safe for typical hostnames, usernames, and
 * paths: any segment containing whitespace or shell metacharacters is
 * single-quoted.
 */
export function buildSshCommand(
  connection: Connection,
  credentials: Credential[],
): string {
  const find = (id?: string) =>
    id ? credentials.find((c) => c.id === id) : undefined;

  const parts: string[] = ["ssh"];
  const push = (...xs: string[]) => parts.push(...xs);

  const destCred = find(connection.credential_id);

  const identity = (cred?: Credential) =>
    cred && cred.type === "ssh_key" && cred.private_key_path
      ? cred.private_key_path
      : undefined;

  const userAt = (user: string | undefined, host: string) =>
    user ? `${q(user)}@${q(host)}` : q(host);

  const proxy = connection.proxy_command?.trim() || undefined;
  if (proxy && connection.type !== "jump_shell") push("-o", q(`ProxyCommand=${proxy}`));

  if (connection.type === "port_forward") {
    const gwCred = find(connection.gateway_credential_id);
    const local = connection.local_port;
    const dest = `${connection.destination_host}:${connection.destination_port}`;
    push("-L", q(`${local}:${dest}`));
    const idFile = identity(gwCred);
    if (idFile) push("-i", q(idFile));
    const gwPort = connection.gateway_port;
    if (gwPort !== 22) push("-p", String(gwPort));
    push(userAt(gwCred?.username, connection.gateway_host));
    return parts.join(" ");
  }

  if (connection.type === "jump_shell") {
    const gwCred = find(connection.gateway_credential_id);
    const gwPort = connection.gateway_port;
    if (proxy) {
      // The outer ssh expands %h/%p first, so the inner command's own
      // tokens are escaped as %%.
      const inner = proxy.replace(/%/g, "%%").replace(/"/g, '\\"');
      const hop = [`ssh -o "ProxyCommand=${inner}" -W %h:%p`];
      if (gwPort !== 22) hop.push(`-p ${gwPort}`);
      hop.push(userAt(gwCred?.username, connection.gateway_host));
      push("-o", q(`ProxyCommand=${hop.join(" ")}`));
    } else {
      const jumpHost =
        gwPort === 22
          ? connection.gateway_host
          : `${connection.gateway_host}:${gwPort}`;
      push("-J", userAt(gwCred?.username, jumpHost));
    }
    const idFile = identity(destCred);
    if (idFile) push("-i", q(idFile));
    const destPort = connection.destination_port;
    if (destPort !== 22) push("-p", String(destPort));
    push(userAt(destCred?.username, connection.destination_host));
    return parts.join(" ");
  }

  // direct
  const idFile = identity(destCred);
  if (idFile) push("-i", q(idFile));
  if (connection.port && connection.port !== 22) push("-p", String(connection.port));
  push(userAt(destCred?.username, connection.host));
  return parts.join(" ");
}

/**
 * POSIX shell-quote a single token. Returns the token unchanged when it
 * contains only safe characters; otherwise wraps it in single quotes and
 * escapes embedded single quotes via the standard `'\''` dance.
 */
function q(token: string): string {
  if (token === "") return "''";
  if (/^[A-Za-z0-9_./:@%+\-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}
