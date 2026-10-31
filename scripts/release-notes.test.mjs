import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatNotes, readChanges } from "./release-notes.mjs";

const INSTALL = "Download and run it.\n";

describe("release notes", () => {
  let repo;
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const commit = (path, subject) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), subject);
    git("add", "-A");
    git("commit", "-q", "-m", subject);
  };

  // main: v1 -- fix on main -- merge of PR #7 (app change, CI change) -- v2
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "ssix-notes-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    commit("src/a.ts", "Start");
    git("tag", "v1");
    commit("src-tauri/src/b.rs", "Fix a crash on main");
    git("checkout", "-q", "-b", "feature");
    commit("src/c.ts", "Add scripts");
    commit(".github/workflows/ci.yml", "Run tests on Windows");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "feature", "-m", "Merge pull request #7 from someone/feature");
    git("tag", "v2");
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("lists each commit since the previous tag with its pull request", () => {
    const { previous, changes } = readChanges("v2", repo);
    expect(previous).toBe("v1");
    expect(changes).toEqual([
      { subject: "Fix a crash on main", pr: null, buildOnly: false },
      { subject: "Add scripts", pr: "7", buildOnly: false },
      { subject: "Run tests on Windows", pr: "7", buildOnly: true },
    ]);
  });

  it("puts app changes first and the install steps last", () => {
    const { previous, changes } = readChanges("v2", repo);
    expect(formatNotes({ tag: "v2", previous, repo: "o/r", changes }, INSTALL)).toBe(
      [
        "## What's changed since v1",
        "",
        "- Fix a crash on main",
        "- Add scripts (#7)",
        "",
        "**Build, tests and docs**",
        "",
        "- Run tests on Windows (#7)",
        "",
        "**Full diff:** https://github.com/o/r/compare/v1...v2",
        "",
        "---",
        "",
        "Download and run it.",
        "",
      ].join("\n"),
    );
  });

  it("handles the first tag and a release with no app changes", () => {
    expect(readChanges("v1", repo).previous).toBeNull();
    expect(formatNotes({ tag: "v1", previous: null, repo: "o/r", changes: [] }, INSTALL)).toMatch(
      /^## First release\n\n---\n\nDownload and run it\.\n$/,
    );
    const ciOnly = [{ subject: "Run tests on Windows", pr: "7", buildOnly: true }];
    expect(formatNotes({ tag: "v2", previous: "v1", repo: "o/r", changes: ciOnly }, INSTALL)).toContain(
      "No changes to the app itself.",
    );
  });
});
