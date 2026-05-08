import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Connection and credential creation/editing now render inline inside
 * their respective views.
 */
describe("App.tsx form mounting structure", () => {
  const src = readFileSync(
    resolve(__dirname, "../App.tsx"),
    "utf8",
  );

  it("mounts <ConnectionForm exactly once", () => {
    const matches = src.match(/<ConnectionForm[\s\n]/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("mounts <CredentialForm exactly once", () => {
    const matches = src.match(/<CredentialForm[\s\n]/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("the connections-view branch renders <ConnectionForm inline", () => {
    const start = src.indexOf('view === "connections"');
    const end = src.indexOf('view === "credentials"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const slice = src.slice(start, end);
    expect(slice).toMatch(/<ConnectionForm[\s\n]/);
  });

  it("the credentials-view branch renders <CredentialForm inline", () => {
    const start = src.indexOf('view === "credentials"');
    const end = src.indexOf('view === "tunnels"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const slice = src.slice(start, end);
    expect(slice).toMatch(/<CredentialForm[\s\n]/);
  });

  it("Cmd+N switches to Connections before opening the form", () => {
    const handlerStart = src.indexOf('"mod+n":');
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerBody = src.slice(handlerStart, handlerStart + 400);
    expect(handlerBody).toMatch(/setView\(["']connections["']\)/);
    expect(handlerBody).toMatch(
      /setConnFormOpen\(true\)|openNewConnection\(\)/,
    );
  });
});
