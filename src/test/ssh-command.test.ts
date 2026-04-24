import { describe, it, expect } from "vitest";
import { buildSshCommand } from "@/lib/ssh-command";
import type { Connection, Credential, DirectConnection } from "@/types";

const passCred: Credential = {
  id: "p1",
  name: "Prod password",
  username: "alice",
  type: "password",
  password: "secret",
};

const keyCred: Credential = {
  id: "k1",
  name: "Prod key",
  username: "deploy",
  type: "ssh_key",
  private_key_path: "/home/u/.ssh/id_ed25519",
};

const keyCredInline: Credential = {
  id: "k2",
  name: "Inline key",
  username: "deploy",
  type: "ssh_key",
  private_key: "-----BEGIN OPENSSH PRIVATE KEY-----",
};

const directConn = (overrides: Partial<DirectConnection> = {}): Connection => ({
  id: "c1",
  name: "web",
  host: "example.com",
  port: 22,
  type: "direct",
  credential_id: passCred.id,
  ...overrides,
});

describe("buildSshCommand", () => {
  it("builds a minimal direct command", () => {
    const cmd = buildSshCommand(directConn(), [passCred]);
    expect(cmd).toBe("ssh alice@example.com");
  });

  it("includes -p when port is non-default", () => {
    const cmd = buildSshCommand(directConn({ port: 2222 }), [passCred]);
    expect(cmd).toBe("ssh -p 2222 alice@example.com");
  });

  it("includes -i for ssh_key credentials with a path", () => {
    const cmd = buildSshCommand(
      directConn({ credential_id: keyCred.id }),
      [keyCred],
    );
    expect(cmd).toBe("ssh -i /home/u/.ssh/id_ed25519 deploy@example.com");
  });

  it("omits -i for ssh_key credentials with only inline contents", () => {
    const cmd = buildSshCommand(
      directConn({ credential_id: keyCredInline.id }),
      [keyCredInline],
    );
    expect(cmd).toBe("ssh deploy@example.com");
  });

  it("omits the user@ prefix when no credential matches", () => {
    const cmd = buildSshCommand(directConn({ credential_id: "missing" }), []);
    expect(cmd).toBe("ssh example.com");
  });

  it("builds a port_forward command using the gateway credential", () => {
    const conn: Connection = {
      id: "c2",
      name: "fwd",
      host: "",
      port: 22,
      type: "port_forward",
      gateway_host: "bastion.example",
      gateway_port: 22,
      gateway_credential_id: keyCred.id,
      local_port: 5432,
      destination_host: "db.internal",
      destination_port: 5432,
    };
    const cmd = buildSshCommand(conn, [keyCred]);
    expect(cmd).toBe(
      "ssh -L 5432:db.internal:5432 -i /home/u/.ssh/id_ed25519 deploy@bastion.example",
    );
  });

  it("builds a jump_shell command with -J", () => {
    const conn: Connection = {
      id: "c3",
      name: "jump",
      host: "",
      port: 22,
      type: "jump_shell",
      gateway_host: "bastion.example",
      gateway_port: 2200,
      gateway_credential_id: passCred.id,
      destination_host: "internal.example",
      destination_port: 22,
      credential_id: keyCred.id,
    };
    const cmd = buildSshCommand(conn, [passCred, keyCred]);
    expect(cmd).toBe(
      "ssh -J alice@bastion.example:2200 -i /home/u/.ssh/id_ed25519 deploy@internal.example",
    );
  });

  it("shell-quotes hosts containing unsafe characters", () => {
    const cmd = buildSshCommand(
      directConn({ host: "weird host with spaces" }),
      [passCred],
    );
    expect(cmd).toBe("ssh alice@'weird host with spaces'");
  });
});
