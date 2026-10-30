import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(__dirname, "..", rel), "utf8");

/**
 * Connection and credential creation/editing render inline inside
 * their respective views, each mounted exactly once.
 */
describe("Form mounting structure", () => {
  const app = read("App.tsx");
  const connectionsView = read("components/views/ConnectionsView.tsx");
  const credentialsView = read("components/views/CredentialsView.tsx");

  it("mounts <ConnectionForm exactly once, inside ConnectionsView", () => {
    expect(connectionsView.match(/<ConnectionForm[\s\n]/g) ?? []).toHaveLength(1);
    expect(app).not.toMatch(/<ConnectionForm[\s\n]/);
  });

  it("mounts <CredentialForm exactly once, inside CredentialsView", () => {
    expect(credentialsView.match(/<CredentialForm[\s\n]/g) ?? []).toHaveLength(1);
    expect(app).not.toMatch(/<CredentialForm[\s\n]/);
  });

  it("App renders each view in its own branch", () => {
    const conn = app.indexOf('view === "connections"');
    const cred = app.indexOf('view === "credentials"', conn);
    const tun = app.indexOf('view === "tunnels"', cred);
    expect(conn).toBeGreaterThan(-1);
    expect(app.slice(conn, cred)).toMatch(/<ConnectionsView[\s\n]/);
    expect(app.slice(cred, tun)).toMatch(/<CredentialsView[\s\n]/);
  });

  it("Cmd+N switches to Connections before opening the form", () => {
    const handlerStart = app.indexOf('"mod+n":');
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerBody = app.slice(handlerStart, handlerStart + 400);
    expect(handlerBody).toMatch(/setView\(["']connections["']\)/);
    expect(handlerBody).toMatch(/setConnFormOpen\(true\)|openNewConnection\(\)/);
  });
});
