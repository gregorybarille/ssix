import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * P2-26 hoisted ConnectionForm and CredentialForm out of the
 * view-conditional branches so Cmd+N (and any future cross-view
 * trigger) can open them without first switching views, and so an
 * in-progress draft survives a navigation. This structural test
 * locks in that hoist: the JSX `<ConnectionForm`/`<CredentialForm`
 * tag must NOT appear inside any `view === "connections"` /
 * `view === "credentials"` branch.
 *
 * If you intentionally re-introduce a per-view form (e.g. an inline
 * editor), update this test alongside the change.
 */
describe("App.tsx form mounting structure", () => {
  const src = readFileSync(
    resolve(__dirname, "../App.tsx"),
    "utf8",
  );

  it("mounts <ConnectionForm exactly once at the App root", () => {
    const matches = src.match(/<ConnectionForm[\s\n]/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("mounts <CredentialForm exactly once at the App root", () => {
    const matches = src.match(/<CredentialForm[\s\n]/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("the connections-view branch does not render <ConnectionForm", () => {
    // Slice from the connections view opener to the start of the
    // credentials view branch and assert the form tag is absent.
    const start = src.indexOf('view === "connections"');
    const end = src.indexOf('view === "credentials"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const slice = src.slice(start, end);
    expect(slice).not.toMatch(/<ConnectionForm[\s\n]/);
  });

  it("the credentials-view branch does not render <CredentialForm", () => {
    const start = src.indexOf('view === "credentials"');
    const end = src.indexOf('view === "tunnels"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const slice = src.slice(start, end);
    expect(slice).not.toMatch(/<CredentialForm[\s\n]/);
  });

  it("Cmd+N handler does not switch view before opening the form", () => {
    // The pre-P2-26 handler called setView("connections") first, which
    // caused a one-render lag and discarded any in-progress edit on
    // another view. The new handler just opens the form; the view
    // switch is no longer needed because the form is App-level.
    //
    // Audit-4 Phase 5d: dialog state moved into useDialogsStore, so
    // the handler now calls dialogs.openNewConnection() instead of
    // setConnFormOpen(true). Either form satisfies the invariant.
    const handlerStart = src.indexOf('"mod+n":');
    expect(handlerStart).toBeGreaterThan(-1);
    // Look at the next 400 characters of the handler body.
    const handlerBody = src.slice(handlerStart, handlerStart + 400);
    expect(handlerBody).not.toMatch(/setView\(["']connections["']\)/);
    expect(handlerBody).toMatch(
      /setConnFormOpen\(true\)|openNewConnection\(\)/,
    );
  });
});
