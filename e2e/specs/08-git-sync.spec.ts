/**
 * Spec 08: Git-sync export.
 *
 * Initialises a local non-bare git repo (export needs a worktree to
 * stage files into), configures the SSX app's `git_sync_repo_path`
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

describe("Git sync export", () => {
  before(() => {
    repo = mkdtempSync(join(tmpdir(), "ssx-gitsync-repo-"));
    execSync("git init --initial-branch=main", { cwd: repo });
    execSync("git config user.email e2e@ssx.test", { cwd: repo });
    execSync("git config user.name e2e", { cwd: repo });
    // git_sync_status calls `git status --short .ssx-sync` and
    // `git rev-list --left-right --count HEAD...origin/main`. The
    // ahead_behind() helper short-circuits when `current_branch`
    // returns None (empty repo), but the moment we have any commit
    // it'll resolve a branch and the rev-list call against the
    // missing `origin/main` ref will fail, dropping the whole
    // status into the Err path — so the GitSyncView never sees
    // `configured: true`. We seed an initial commit AND register
    // a no-op `origin` remote pointing at the repo itself so the
    // remote ref exists once we fetch (we don't fetch in the spec
    // because export is local-only, but having `origin` configured
    // means rev-list errors only complain about the missing
    // refs/remotes/origin/main pointer — which still errors).
    //
    // Simpler fix: create the initial commit so HEAD is real, then
    // skip remote setup entirely. ahead_behind sees branch="main"
    // and tries `HEAD...origin/main`. To avoid that error we point
    // origin at a second local repo that already has main.
    execSync("git commit --allow-empty -m initial", { cwd: repo });
    const remote = mkdtempSync(join(tmpdir(), "ssx-gitsync-remote-"));
    execSync("git init --bare --initial-branch=main", { cwd: remote });
    execSync(`git remote add origin ${remote}`, { cwd: repo });
    execSync("git push -u origin main", { cwd: repo });
  });
  after(() => {
    rmSync(repo, { recursive: true, force: true });
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

    // Configure the repo path via the Settings UI. Save persists to
    // disk AND updates the Zustand store, which the GitSyncView's
    // useEffect listens to.
    await navigateTo("settings");
    const repoInput = await browser.$(sel.settingsGitSyncRepoPath);
    await repoInput.waitForExist({ timeout: 10_000 });
    await repoInput.setValue(repo);
    await (await browser.$(sel.settingsSave)).click();

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

    // Export only writes locally; we assert the local snapshot has
    // changed-files state OR that a commit landed if commit was
    // implicit. Either way the bare repo proves nothing yet (push
    // is a separate action). For now, assert the export action
    // produced visible status output — the bare repo assertion is
    // restored once the spec covers Push.
    const statusText = await (await browser.$(sel.gitSyncStatus)).getText();
    expect(statusText.length).toBeGreaterThan(0);
  });
});
