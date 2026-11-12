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

  it("builds a remote_forward command with -R against the SSH server", () => {
    const conn: Connection = {
      id: "c2r",
      name: "rfwd",
      host: "",
      port: 22,
      type: "remote_forward",
      gateway_host: "bastion.example",
      gateway_port: 2200,
      gateway_credential_id: keyCred.id,
      remote_port: 8080,
      destination_host: "127.0.0.1",
      destination_port: 3000,
    };
    expect(buildSshCommand(conn, [keyCred])).toBe(
      "ssh -R 8080:127.0.0.1:3000 -i /home/u/.ssh/id_ed25519 -p 2200 deploy@bastion.example",
    );
  });

  it("builds a dynamic_forward command with -D", () => {
    const conn: Connection = {
      id: "c2d",
      name: "socks",
      host: "",
      port: 22,
      type: "dynamic_forward",
      gateway_host: "bastion.example",
      gateway_port: 22,
      gateway_credential_id: passCred.id,
      local_port: 1080,
    };
    expect(buildSshCommand(conn, [passCred])).toBe("ssh -D 1080 alice@bastion.example");
  });

  it("puts a forward's bind address in front of its port", () => {
    const socks: Connection = {
      id: "c2d",
      name: "socks",
      host: "",
      port: 22,
      type: "dynamic_forward",
      gateway_host: "bastion.example",
      gateway_port: 22,
      gateway_credential_id: passCred.id,
      local_port: 1080,
    };
    expect(buildSshCommand({ ...socks, bind_address: "0.0.0.0" }, [passCred])).toBe(
      "ssh -D 0.0.0.0:1080 alice@bastion.example",
    );
    expect(buildSshCommand({ ...socks, bind_address: "::1" }, [passCred])).toBe(
      "ssh -D '[::1]:1080' alice@bastion.example",
    );
    const local: Connection = {
      ...socks,
      type: "port_forward",
      destination_host: "db",
      destination_port: 5432,
      bind_address: "10.0.0.5",
    };
    expect(buildSshCommand(local, [passCred])).toBe(
      "ssh -L 10.0.0.5:1080:db:5432 alice@bastion.example",
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

  it("brackets an IPv6 destination or jump host, as ssh needs to split off the port", () => {
    const forward: Connection = {
      id: "c6",
      name: "fwd",
      host: "",
      port: 22,
      type: "port_forward",
      gateway_host: "bastion.example",
      gateway_port: 22,
      gateway_credential_id: passCred.id,
      local_port: 8080,
      destination_host: "::1",
      destination_port: 80,
    };
    expect(buildSshCommand(forward, [passCred])).toBe(
      "ssh -L '8080:[::1]:80' alice@bastion.example",
    );
    const remote: Connection = {
      ...forward,
      type: "remote_forward",
      remote_port: 9000,
    } as Connection;
    expect(buildSshCommand(remote, [passCred])).toBe(
      "ssh -R '9000:[::1]:80' alice@bastion.example",
    );
    const jump = (gateway_port: number): Connection => ({
      id: "c7",
      name: "jump",
      host: "",
      port: 22,
      type: "jump_shell",
      gateway_host: "fe80::1",
      gateway_port,
      gateway_credential_id: passCred.id,
      destination_host: "internal.example",
      destination_port: 22,
      credential_id: keyCred.id,
    });
    expect(buildSshCommand(jump(2222), [passCred, keyCred])).toBe(
      "ssh -J alice@'[fe80::1]:2222' -i /home/u/.ssh/id_ed25519 deploy@internal.example",
    );
    expect(buildSshCommand(jump(22), [passCred, keyCred])).toBe(
      "ssh -J alice@'[fe80::1]' -i /home/u/.ssh/id_ed25519 deploy@internal.example",
    );
  });

  it("shell-quotes hosts containing unsafe characters", () => {
    const cmd = buildSshCommand(
      directConn({ host: "weird host with spaces" }),
      [passCred],
    );
    expect(cmd).toBe("ssh alice@'weird host with spaces'");
  });
  it("passes a proxy command with -o ProxyCommand", () => {
    const cmd = buildSshCommand(
      directConn({ proxy_command: "wsl.exe -e nc %h %p" }),
      [passCred],
    );
    expect(cmd).toBe("ssh -o 'ProxyCommand=wsl.exe -e nc %h %p' alice@example.com");
  });

  describe("agent forwarding", () => {
    it("adds -A to a direct connection", () => {
      expect(buildSshCommand(directConn({ agent_forwarding: true }), [passCred])).toBe(
        "ssh -A alice@example.com",
      );
    });

    it("adds -A to a jump host connection", () => {
      const conn: Connection = {
        id: "c5",
        name: "jump",
        host: "",
        port: 22,
        type: "jump_shell",
        gateway_host: "bastion.example",
        gateway_port: 22,
        gateway_credential_id: passCred.id,
        destination_host: "internal.example",
        destination_port: 22,
        credential_id: keyCred.id,
        agent_forwarding: true,
      };
      expect(buildSshCommand(conn, [passCred, keyCred])).toBe(
        "ssh -A -J alice@bastion.example -i /home/u/.ssh/id_ed25519 deploy@internal.example",
      );
    });

    it("adds -A to a forward", () => {
      const conn: Connection = {
        id: "c6",
        name: "socks",
        host: "",
        port: 22,
        type: "dynamic_forward",
        gateway_host: "bastion.example",
        gateway_port: 22,
        gateway_credential_id: passCred.id,
        local_port: 1080,
        agent_forwarding: true,
      };
      expect(buildSshCommand(conn, [passCred])).toBe("ssh -A -D 1080 alice@bastion.example");
    });

    it("leaves it out when off", () => {
      expect(buildSshCommand(directConn({ agent_forwarding: false }), [passCred])).toBe(
        "ssh alice@example.com",
      );
    });
  });

  it("spells out the jump when the jump host has a proxy command", () => {
    const conn: Connection = {
      id: "c4",
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
      proxy_command: "nc %h %p",
    };
    expect(buildSshCommand(conn, [passCred, keyCred])).toBe(
      "ssh -o 'ProxyCommand=ssh -o \"ProxyCommand=nc %%h %%p\" -W %h:%p -p 2200 alice@bastion.example'" +
        " -i /home/u/.ssh/id_ed25519 deploy@internal.example",
    );
  });
});
