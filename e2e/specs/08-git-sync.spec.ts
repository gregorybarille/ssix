/**
 * Spec 08: Git-sync export.
 *
 * Initialises a local non-bare git repo (export needs a worktree to
 * stage files into), configures the SSIX app's `git_sync_repo_path`
 * setting via the Settings UI (so the in-memory store is updated and
 * the GitSyncView fetches a fresh status), then runs the export and
 * asserts the action produced visible status.
 *
 * Earlier revisions of this spec wrote the path directly into
 * `data.json`, but that bypasses the Zustand settings store — the
 * GitSyncView keeps showing `status.configured === false` until the
 * store re-reads from disk, and the `git-sync-repo-path` testid never
 * mounts. An even earlier revision used `git init --bare` which the
 * Rust `ensure_repo_exists` check rejects (no `.git` subdir on a bare
 * repo); export also requires a worktree.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForAppReady } from "../helpers/app.js";
import {
  createPasswordCredential,
  createDirectConnection,
  navigateTo,
} from "../helpers/flows.js";
import { sel } from "../helpers/selectors.js";

let repo: string;
let remote: string;

describe("Git sync export", () => {
  before(() => {
    // A repo with no commits and an empty remote: the very first sync.
    repo = mkdtempSync(join(tmpdir(), "ssix-gitsync-repo-"));
    execSync("git init --initial-branch=main", { cwd: repo });
    execSync("git config user.email e2e@ssix.test", { cwd: repo });
    execSync("git config user.name e2e", { cwd: repo });
    remote = mkdtempSync(join(tmpdir(), "ssix-gitsync-remote-"));
    execSync("git init --bare --initial-branch=main", { cwd: remote });
    execSync(`git remote add origin ${remote}`, { cwd: repo });
  });
  after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });

  it("exports the catalogue to a local repo", async () => {
    await waitForAppReady();
    // Need at least one connection so the export has content.
    await createPasswordCredential({
      name: "cred-gitsync",
      username: "usera",
      password: "passa",
    });
    await createDirectConnection({
      name: "conn-gitsync",
      host: "server-a",
      port: 22,
      credentialName: "cred-gitsync",
    });

    // Configure the repo path via the Settings UI. The settings panel
    // now auto-saves git-sync text fields on blur instead of exposing
    // a dedicated Save button. Saves are debounced (~300 ms), so wait
    // for the "Settings saved!" confirmation before leaving the panel:
    // GitSyncView fetches status on mount and would otherwise race the
    // flush that leaving the panel triggers.
    await navigateTo("settings");
    const repoInput = await browser.$(sel.settingsGitSyncRepoPath);
    await repoInput.waitForExist({ timeout: 10_000 });
    await repoInput.setValue(repo);
    await browser.execute((el: HTMLElement) => el.blur(), repoInput);
    const savedStatus = await browser.$(sel.settingsSavedStatus);
    await browser.waitUntil(
      async () => /settings saved/i.test(await savedStatus.getText()),
      { timeout: 10_000, timeoutMsg: "settings panel did not confirm the save" },
    );

    await navigateTo("git-sync");
    // Confirm the view picked up the configured repo path.
    const repoPath = await browser.$(sel.gitSyncRepoPath);
    await repoPath.waitForExist({ timeout: 10_000 });
    await browser.waitUntil(
      async () => (await repoPath.getText()).includes(repo),
      { timeout: 10_000, timeoutMsg: "git-sync did not pick up repo path" },
    );

    await (await browser.$(sel.gitSyncExportButton)).click();
    await browser.waitUntil(
      async () =>
        /done|success|exported|snapshot/i.test(
          await (await browser.$(sel.gitSyncStatus)).getText(),
        ),
      { timeout: 30_000, timeoutMsg: "git-sync export did not complete" },
    );

    // Export only writes locally; the next test covers the push.
    const statusText = await (await browser.$(sel.gitSyncStatus)).getText();
    expect(statusText.length).toBeGreaterThan(0);
  });

  it("first sync commits and pushes into an empty remote", async () => {
    await (await browser.$(sel.gitSyncRunButton)).click();
    await browser.waitUntil(
      async () =>
        /pushed 1 commit/i.test(
          await (await browser.$(sel.gitSyncStatus)).getText(),
        ),
      { timeout: 30_000, timeoutMsg: "first sync did not push" },
    );

    const pushed = execSync("git show main:.ssix-sync/data.json", {
      cwd: remote,
      encoding: "utf8",
    });
    expect(pushed).toContain("conn-gitsync");
    expect(pushed).not.toContain("passa");
  });
});
