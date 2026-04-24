import type { Connection, Credential } from "@/types";

/**
 * Build a portable `ssh` CLI command for the given connection.
 *
 * The shape mirrors what the `ssh2` backend dials:
 *
 * - `direct`: `ssh [-i KEY] [-p PORT] user@host`
 * - `jump_shell`: `ssh -J jumpUser@gateway[:port] [-i KEY] [-p PORT] user@host`
 * - `port_forward`: `ssh -L LOCAL:DEST:DEST_PORT [-i KEY] jumpUser@gateway[:port]`
 *   (this matches how OpenSSH would tunnel the same destination — the
 *   gateway is the host you actually connect to, not the destination.)
 *
 * The username is resolved from the destination credential when present, and
 * falls back to the gateway credential for `port_forward`. If no credential
 * matches (e.g. inline auth that hasn't been saved yet), the user portion is
 * omitted and the user is expected to fill it in.
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
  const gwCred = find(connection.gateway_credential_id);

  const identity = (cred?: Credential) =>
    cred && cred.type === "ssh_key" && cred.private_key_path
      ? cred.private_key_path
      : undefined;

  const userAt = (user: string | undefined, host: string) =>
    user ? `${q(user)}@${q(host)}` : q(host);

  if (connection.type === "port_forward") {
    const local = connection.local_port ?? 0;
    const dest = `${connection.destination_host ?? ""}:${connection.destination_port ?? 22}`;
    push("-L", q(`${local}:${dest}`));
    const idFile = identity(gwCred);
    if (idFile) push("-i", q(idFile));
    const gwPort = connection.gateway_port ?? 22;
    if (gwPort !== 22) push("-p", String(gwPort));
    push(userAt(gwCred?.username, connection.gateway_host ?? ""));
    return parts.join(" ");
  }

  if (connection.type === "jump_shell") {
    const gwPort = connection.gateway_port ?? 22;
    const jumpHost =
      gwPort === 22
        ? (connection.gateway_host ?? "")
        : `${connection.gateway_host ?? ""}:${gwPort}`;
    push("-J", userAt(gwCred?.username, jumpHost));
    const idFile = identity(destCred);
    if (idFile) push("-i", q(idFile));
    const destPort = connection.destination_port ?? 22;
    if (destPort !== 22) push("-p", String(destPort));
    push(userAt(destCred?.username, connection.destination_host ?? ""));
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
