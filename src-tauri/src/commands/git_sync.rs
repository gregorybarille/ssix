use crate::commands::blocking;
use crate::keychain;
use crate::models::{AppData, AppSettings, CredentialKind};
use crate::storage;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(test)]
use ts_rs::TS;

const EXPORT_DIR: &str = ".ssix-sync";
const DATA_FILE: &str = "data.json";
const SUMMARY_FILE: &str = "README.md";
/// Without it, line ending conversion makes git report changes it won't commit.
const ATTRIBUTES_FILE: &str = ".gitattributes";
const DEFAULT_COMMIT_MESSAGE: &str = "sync ssix config snapshot";
/// SHA-256 of what SSIX last wrote, per generated file, kept in the git directory.
const LAST_EXPORT_RECORD: &str = "ssix-sync-last-export";

#[derive(Debug, Serialize)]
pub struct GitSyncStatus {
    pub configured: bool,
    pub repo_path: Option<String>,
    pub branch: Option<String>,
    pub remote: Option<String>,
    pub has_local_changes: bool,
    pub has_remote_changes: bool,
    pub ahead: u32,
    pub behind: u32,
    pub changed_files: Vec<String>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct GitSyncDiff {
    pub staged: String,
    pub unstaged: String,
    /// Generated files holding hand edits. The refresh left them as they are.
    pub at_risk: Vec<String>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct GitSyncSnapshot {
    pub repo_path: String,
    pub exported_files: Vec<String>,
    /// Set when the export stopped for the user's answer: the files whose edits
    /// it would lose. Nothing was changed.
    pub at_risk: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct GitSyncActionResult {
    pub stdout: String,
    pub stderr: String,
    pub status: i32,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct GitSyncRunResult {
    pub steps: Vec<String>,
    pub output: GitSyncActionResult,
    /// Set when the action stopped for the user's answer: the files under
    /// `.ssix-sync/` whose edits it would lose. Nothing was changed.
    pub at_risk: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct GitSyncRunInput {
    /// The files the user agreed to lose edits in. Anything else at risk asks again.
    pub agreed: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
pub struct GitSyncCommitInput {
    pub message: String,
    /// The files the user agreed to lose edits in. Anything else at risk asks again.
    pub agreed: Vec<String>,
}

/// Reject a remote git could read as an option. A remote may be a name
/// (`origin`), a URL (`git@host:me/cfg.git`, `https://...`) or a local path
/// (which may contain spaces: it is passed as one argv element, never
/// through a shell), so only the option-injection shape and control
/// characters are refused.
pub(crate) fn validate_git_remote(value: &str) -> Result<(), String> {
    let v = value.trim();
    if v.is_empty() {
        return Err("Git remote is required.".to_string());
    }
    if v.starts_with('-') {
        return Err("Git remote must not start with '-'.".to_string());
    }
    if v.chars().any(char::is_control) {
        return Err("Git remote must not contain control characters.".to_string());
    }
    Ok(())
}

/// Reject a branch that is not a valid ref component or that git could
/// read as an option.
pub(crate) fn validate_git_branch(value: &str) -> Result<(), String> {
    let v = value.trim();
    if v.is_empty() {
        return Err("Git branch is required.".to_string());
    }
    if v.starts_with('-') {
        return Err("Git branch must not start with '-'.".to_string());
    }
    if v.contains("..") || v.ends_with(".lock") || v.ends_with('/') || v.ends_with('.') {
        return Err("Git branch is not a valid git ref name.".to_string());
    }
    if v.chars().any(|c| {
        c.is_control() || c.is_whitespace() || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
    }) {
        return Err("Git branch contains characters git does not allow.".to_string());
    }
    Ok(())
}

fn configured_remote(settings: &AppSettings) -> Result<String, String> {
    let remote = settings.git_sync_remote.trim();
    validate_git_remote(remote)?;
    Ok(remote.to_string())
}

#[tauri::command]
pub async fn git_sync_status() -> Result<GitSyncStatus, String> {
    blocking(git_sync_status_sync).await
}

fn git_sync_status_sync() -> Result<GitSyncStatus, String> {
    let data = storage::load_data()?;
    let Some(repo_path) = configured_repo_path(&data.settings) else {
        return Ok(GitSyncStatus {
            configured: false,
            repo_path: None,
            branch: None,
            remote: None,
            has_local_changes: false,
            has_remote_changes: false,
            ahead: 0,
            behind: 0,
            changed_files: Vec::new(),
        });
    };

    ensure_repo_exists(&repo_path)?;
    status_in(&repo_path, &data.settings)
}

fn status_in(repo_path: &Path, settings: &AppSettings) -> Result<GitSyncStatus, String> {
    let branch = sync_branch(repo_path, settings)?;
    let remote = configured_remote(settings)?;
    let porcelain = git(repo_path, &["status", "--short", "--", EXPORT_DIR])?;
    let changed_files = porcelain
        .stdout
        .lines()
        .filter_map(parse_status_path)
        .collect::<Vec<_>>();
    let has_local_changes = !changed_files.is_empty();
    let (ahead, behind) = ahead_behind(repo_path, &remote, branch.as_deref())?;

    Ok(GitSyncStatus {
        configured: true,
        repo_path: Some(repo_path.display().to_string()),
        branch,
        remote: Some(remote),
        has_local_changes,
        has_remote_changes: behind > 0,
        ahead,
        behind,
        changed_files,
    })
}

#[tauri::command]
pub async fn git_sync_export_snapshot(input: GitSyncRunInput) -> Result<GitSyncSnapshot, String> {
    blocking(move || git_sync_export_snapshot_sync(input)).await
}

fn git_sync_export_snapshot_sync(input: GitSyncRunInput) -> Result<GitSyncSnapshot, String> {
    let (data, repo_path) = require_configured_repo()?;
    export_in(&repo_path, &data, &input.agreed)
}

fn export_in(
    repo_path: &Path,
    data: &AppData,
    agreed: &[String],
) -> Result<GitSyncSnapshot, String> {
    let files = snapshot_files(data)?;
    let at_risk = needing_agreement(files_at_risk(repo_path, &files, false)?, agreed);
    let mut exported_files = Vec::new();
    if at_risk.is_empty() {
        export_snapshot(repo_path, &files, &[])?;
        exported_files = files.into_iter().map(|(path, _)| path).collect();
    }

    Ok(GitSyncSnapshot {
        repo_path: repo_path.display().to_string(),
        exported_files,
        at_risk,
    })
}

#[tauri::command]
pub async fn git_sync_diff() -> Result<GitSyncDiff, String> {
    blocking(git_sync_diff_sync).await
}

fn git_sync_diff_sync() -> Result<GitSyncDiff, String> {
    let (data, repo_path) = require_configured_repo()?;
    diff_in(&repo_path, &data)
}

/// Not always something the user asked to export with, so it never overwrites a
/// hand edit and never asks: it exports the other files and reports those.
fn diff_in(repo_path: &Path, data: &AppData) -> Result<GitSyncDiff, String> {
    let files = snapshot_files(data)?;
    let at_risk = files_at_risk(repo_path, &files, false)?;
    export_snapshot(repo_path, &files, &at_risk)?;

    let unstaged = git(repo_path, &["diff", "--", EXPORT_DIR])?.stdout;
    let staged = git(repo_path, &["diff", "--cached", "--", EXPORT_DIR])?.stdout;
    Ok(GitSyncDiff {
        staged,
        unstaged,
        at_risk,
    })
}

#[tauri::command]
pub async fn git_sync_commit(input: GitSyncCommitInput) -> Result<GitSyncRunResult, String> {
    blocking(move || git_sync_commit_sync(input)).await
}

fn git_sync_commit_sync(input: GitSyncCommitInput) -> Result<GitSyncRunResult, String> {
    let (data, repo_path) = require_configured_repo()?;
    commit_in(&repo_path, &data, &input.message, &input.agreed)
}

fn commit_in(
    repo_path: &Path,
    data: &AppData,
    message: &str,
    agreed: &[String],
) -> Result<GitSyncRunResult, String> {
    let result = |output, at_risk| GitSyncRunResult {
        steps: Vec::new(),
        output,
        at_risk,
    };
    let files = snapshot_files(data)?;
    let at_risk = needing_agreement(files_at_risk(repo_path, &files, false)?, agreed);
    if !at_risk.is_empty() {
        return Ok(result(GitSyncActionResult::default(), at_risk));
    }
    export_snapshot(repo_path, &files, &[])?;

    let message = message.trim();
    if message.is_empty() {
        return Err("Commit message is required".to_string());
    }

    git(repo_path, &["add", "--", EXPORT_DIR])?;
    let status = git(repo_path, &["status", "--short", "--", EXPORT_DIR])?;
    if status.stdout.trim().is_empty() {
        return Ok(result(
            GitSyncActionResult {
                stdout: "No changes to commit.".to_string(),
                stderr: String::new(),
                status: 0,
            },
            Vec::new(),
        ));
    }

    let commit = commit_snapshot(repo_path, message)?;
    Ok(result(to_action_result(commit), Vec::new()))
}

#[tauri::command]
pub async fn git_sync_run(input: GitSyncRunInput) -> Result<GitSyncRunResult, String> {
    blocking(move || git_sync_run_sync(input)).await
}

fn git_sync_run_sync(input: GitSyncRunInput) -> Result<GitSyncRunResult, String> {
    let (data, repo_path) = require_configured_repo()?;
    sync_in(&repo_path, &data, &input.agreed)
}

fn sync_in(
    repo_path: &Path,
    data: &AppData,
    agreed: &[String],
) -> Result<GitSyncRunResult, String> {
    let remote = configured_remote(&data.settings)?;
    let branch = branch_name(repo_path, &data.settings)?;
    let mut steps = Vec::new();
    let mut combined_output = String::new();

    let fetch = fetch_remote(repo_path, &remote, &branch)?;
    append_output(&mut combined_output, &fetch);
    steps.push(format!("Fetched {}", remote));

    let (ahead_before_pull, behind_before_pull) = ahead_behind(repo_path, &remote, Some(&branch))?;
    if behind_before_pull > 0 && ahead_before_pull > 0 {
        return Err(format!(
            "This repository and branch {} of {} have diverged ({} local and {} remote commit(s)), and Sync only fast-forwards. \
             In the repository, rebase or merge onto the remote branch, then Sync again. \
             A conflict in {}/ can be resolved either way: Sync exports it again.",
            branch, remote, ahead_before_pull, behind_before_pull, EXPORT_DIR
        ));
    }
    let files = snapshot_files(data)?;
    let at_risk = needing_agreement(
        files_at_risk(repo_path, &files, behind_before_pull > 0)?,
        agreed,
    );
    if !at_risk.is_empty() {
        return Ok(GitSyncRunResult {
            steps,
            output: GitSyncActionResult {
                stdout: combined_output.trim().to_string(),
                stderr: String::new(),
                status: 0,
            },
            at_risk,
        });
    }
    if behind_before_pull > 0 {
        discard_snapshot(repo_path)?;
        let pull = git(repo_path, &["pull", "--ff-only", &remote, &branch])?;
        append_output(&mut combined_output, &pull);
        steps.push(format!(
            "Pulled {} commit(s) from {}/{}",
            behind_before_pull, remote, branch
        ));
    }

    export_snapshot(repo_path, &files, &[])?;
    steps.push("Exported sanitized snapshot".to_string());

    let status = git(repo_path, &["status", "--short", "--", EXPORT_DIR])?;
    let changed_files = status
        .stdout
        .lines()
        .filter_map(parse_status_path)
        .collect::<Vec<_>>();
    if !changed_files.is_empty() {
        git(repo_path, &["add", "--", EXPORT_DIR])?;
        let commit = commit_snapshot(repo_path, DEFAULT_COMMIT_MESSAGE)?;
        append_output(&mut combined_output, &commit);
        steps.push(format!("Committed {} changed file(s)", changed_files.len()));
    } else {
        steps.push("No local snapshot changes to commit".to_string());
    }

    let (ahead_after_commit, _) = ahead_behind(repo_path, &remote, Some(&branch))?;
    if ahead_after_commit > 0 {
        // A full refname: a detached HEAD cannot create a branch from a short one.
        let target = format!("HEAD:refs/heads/{}", branch);
        let push = git(repo_path, &["push", &remote, &target])?;
        append_output(&mut combined_output, &push);
        if !is_named_remote(repo_path, &remote)? {
            git(
                repo_path,
                &["update-ref", &url_tracking_ref(&branch), "HEAD"],
            )?;
        }
        steps.push(format!(
            "Pushed {} commit(s) to {}/{}",
            ahead_after_commit, remote, branch
        ));
    } else {
        steps.push("Nothing to push".to_string());
    }

    Ok(GitSyncRunResult {
        steps,
        output: GitSyncActionResult {
            stdout: if combined_output.trim().is_empty() {
                "Sync complete.".to_string()
            } else {
                combined_output.trim().to_string()
            },
            stderr: String::new(),
            status: 0,
        },
        at_risk: Vec::new(),
    })
}

/// The pathspec keeps whatever else the user has staged out of the commit.
fn commit_snapshot(repo_path: &Path, message: &str) -> Result<GitOutput, String> {
    git(repo_path, &["commit", "-m", message, "--", EXPORT_DIR])
}

/// The one decision on what would really be lost under `.ssix-sync/`, for every
/// path that writes there. `files` is what the export would write; `discarding`
/// means [`discard_snapshot`] runs too, which also takes everything else there.
///
/// Git status decides what is uncommitted, so line ending conversion cannot make
/// a clean file look changed. Without `--untracked-files=all` an untracked folder
/// is one entry, and `status.showUntrackedFiles=no` would hide what `clean` then
/// deletes. `-z` keeps paths unquoted, `--no-renames` keeps each entry one path.
/// `--ignored` because an export overwrites a generated file git ignores as well.
fn files_at_risk(
    repo_path: &Path,
    files: &[(String, String)],
    discarding: bool,
) -> Result<Vec<String>, String> {
    let status = git(
        repo_path,
        &[
            "status",
            "--porcelain",
            "-z",
            "--no-renames",
            "--untracked-files=all",
            "--ignored",
            "--",
            EXPORT_DIR,
        ],
    )?;
    let last_export = read_last_export(repo_path);
    let at_risk = status
        .stdout
        .split('\0')
        .filter_map(|entry| Some((entry.get(..2)?, entry.get(3..)?)))
        .filter(|(state, path)| {
            match files.iter().find(|(file, _)| file.as_str() == *path) {
                Some((_, next)) => match fs::read(repo_path.join(path)) {
                    Ok(current) => {
                        current != next.as_bytes()
                            && last_export.get(*path) != Some(&sha256_hex(&current))
                    }
                    // Already gone, so nothing is left to lose. Unreadable: assume there is.
                    Err(e) => e.kind() != std::io::ErrorKind::NotFound,
                },
                // A deletion the discard undoes loses nothing, and `clean` keeps ignored files.
                None => discarding && !matches!(*state, " D" | "D " | "!!"),
            }
        })
        .map(|(_, path)| path.to_string())
        .collect();
    Ok(at_risk)
}

/// The whole list when anything on it was not agreed to, so the user answers
/// for all of it again; nothing when the action may go ahead.
fn needing_agreement(at_risk: Vec<String>, agreed: &[String]) -> Vec<String> {
    if at_risk.iter().all(|file| agreed.contains(file)) {
        Vec::new()
    } else {
        at_risk
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn last_export_path(repo_path: &Path) -> Result<PathBuf, String> {
    let output = git(repo_path, &["rev-parse", "--git-path", LAST_EXPORT_RECORD])?;
    Ok(repo_path.join(output.stdout.trim_end()))
}

/// A missing or unreadable record is an empty one: uncommitted files then count
/// as hand edits, and one extra question is better than a silent loss.
fn read_last_export(repo_path: &Path) -> HashMap<String, String> {
    last_export_path(repo_path)
        .ok()
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Puts the snapshot back as HEAD has it, so a pull is not refused over it. Sync
/// exports the generated files again, and nothing outside the folder is touched.
/// [`files_at_risk`] has already asked about anything this would really lose.
fn discard_snapshot(repo_path: &Path) -> Result<(), String> {
    git(repo_path, &["reset", "-q", "--", EXPORT_DIR])?;
    // `checkout` fails on a pathspec that matches nothing, as before a first commit.
    if !git(repo_path, &["ls-files", "--", EXPORT_DIR])?
        .stdout
        .is_empty()
    {
        git(repo_path, &["checkout", "-q", "--", EXPORT_DIR])?;
    }
    git(repo_path, &["clean", "-fdq", "--", EXPORT_DIR])?;
    Ok(())
}

fn configured_repo_path(settings: &AppSettings) -> Option<PathBuf> {
    settings
        .git_sync_repo_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

/// Audit-4 Dup H2: shared preamble for the 7 git-sync commands. Each one
/// loaded data, resolved the configured repo path, asserted the repo
/// exists with the same hard-coded message, then proceeded. Concentrating
/// the policy here means a future change (e.g. add a `repo_locked`
/// check, or relax the .git directory test for git worktrees) lands in
/// one place and we can't end up with 6 commands enforcing the new rule
/// and 1 forgotten.
fn require_configured_repo() -> Result<(crate::models::AppData, PathBuf), String> {
    let data = storage::load_data()?;
    let repo_path = configured_repo_path(&data.settings)
        .ok_or_else(|| "Configure a git sync repository path in Settings first".to_string())?;
    ensure_repo_exists(&repo_path)?;
    Ok((data, repo_path))
}

fn ensure_repo_exists(repo_path: &Path) -> Result<(), String> {
    if !repo_path.exists() {
        return Err(format!(
            "Git sync repository does not exist: {}",
            repo_path.display()
        ));
    }
    if !repo_path.join(".git").exists() {
        return Err(format!(
            "Directory is not a git repository: {}",
            repo_path.display()
        ));
    }
    Ok(())
}

fn branch_name(repo_path: &Path, settings: &AppSettings) -> Result<String, String> {
    sync_branch(repo_path, settings)?
        .ok_or_else(|| "Could not determine current git branch".to_string())
}

/// The override, else the current branch, which a detached HEAD does not have.
fn sync_branch(repo_path: &Path, settings: &AppSettings) -> Result<Option<String>, String> {
    if let Some(branch) = settings
        .git_sync_branch
        .as_deref()
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
    {
        validate_git_branch(branch)?;
        return Ok(Some(branch.to_string()));
    }
    current_branch(repo_path)
}

fn current_branch(repo_path: &Path) -> Result<Option<String>, String> {
    let result = git(repo_path, &["branch", "--show-current"])?;
    let branch = result.stdout.trim();
    if branch.is_empty() {
        Ok(None)
    } else {
        Ok(Some(branch.to_string()))
    }
}

fn is_named_remote(repo_path: &Path, remote: &str) -> Result<bool, String> {
    let names = git(repo_path, &["remote"])?.stdout;
    Ok(names.lines().any(|name| name == remote))
}

/// A URL has no refs/remotes/ namespace, and FETCH_HEAD would not do: any other
/// fetch in the repo overwrites it, and status reads the ref long after Sync.
fn url_tracking_ref(branch: &str) -> String {
    format!("refs/ssix-sync/{}", branch)
}

fn fetch_remote(repo_path: &Path, remote: &str, branch: &str) -> Result<GitOutput, String> {
    if is_named_remote(repo_path, remote)? {
        return git(repo_path, &["fetch", remote]);
    }
    let tracking = url_tracking_ref(branch);
    let remote_branch = format!("refs/heads/{}", branch);
    // Fetching a branch the remote does not have is fatal. Asking first avoids
    // matching git's translated error text.
    let found = git(repo_path, &["ls-remote", remote, &remote_branch])?;
    if found.stdout.trim().is_empty() {
        return git(repo_path, &["update-ref", "-d", &tracking]);
    }
    let refspec = format!("+{}:{}", remote_branch, tracking);
    git(repo_path, &["fetch", "--no-tags", remote, &refspec])
}

fn ref_exists(repo_path: &Path, name: &str) -> bool {
    git(repo_path, &["rev-parse", "--verify", "--quiet", name]).is_ok()
}

fn commit_count(repo_path: &Path, rev: &str) -> Result<u32, String> {
    let result = git(repo_path, &["rev-list", "--count", rev])?;
    Ok(result.stdout.trim().parse().unwrap_or(0))
}

/// Commits on HEAD and on the remote branch that the other lacks. A side that
/// does not exist yet (empty remote, new branch, unborn HEAD) has none.
fn ahead_behind(
    repo_path: &Path,
    remote: &str,
    branch: Option<&str>,
) -> Result<(u32, u32), String> {
    let Some(branch) = branch else {
        return Ok((0, 0));
    };
    let remote_ref = if is_named_remote(repo_path, remote)? {
        format!("refs/remotes/{}/{}", remote, branch)
    } else {
        url_tracking_ref(branch)
    };
    match (
        ref_exists(repo_path, "HEAD"),
        ref_exists(repo_path, &remote_ref),
    ) {
        (false, false) => return Ok((0, 0)),
        (true, false) => return Ok((commit_count(repo_path, "HEAD")?, 0)),
        (false, true) => return Ok((0, commit_count(repo_path, &remote_ref)?)),
        (true, true) => {}
    }
    let result = git(
        repo_path,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("HEAD...{}", remote_ref),
        ],
    )?;
    let mut parts = result.stdout.split_whitespace();
    let ahead = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    let behind = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    Ok((ahead, behind))
}

/// What an export writes: paths as git prints them, with their content.
fn snapshot_files(data: &AppData) -> Result<Vec<(String, String)>, String> {
    let sanitized = sanitize_app_data(data)?;
    let data_json = serde_json::to_string_pretty(&sanitized).map_err(|e| e.to_string())?;
    Ok([
        (ATTRIBUTES_FILE, "* -text\n".to_string()),
        (DATA_FILE, data_json),
        (SUMMARY_FILE, render_summary(&sanitized)),
    ]
    .map(|(name, content)| (format!("{}/{}", EXPORT_DIR, name), content))
    .into())
}

/// Writes `files` except `keep`, whose record entry stays too: a kept hand edit
/// must keep differing from what SSIX last wrote.
fn export_snapshot(
    repo_path: &Path,
    files: &[(String, String)],
    keep: &[String],
) -> Result<(), String> {
    let mut last_export = read_last_export(repo_path);
    for (path, content) in files.iter().filter(|(path, _)| !keep.contains(path)) {
        // Audit-4 L1: atomic_write so a crash during the export can't leave a
        // half-written file that subsequent git operations would commit as a
        // partial snapshot.
        storage::atomic_write(&repo_path.join(path), content.as_bytes(), None)?;
        last_export.insert(path.clone(), sha256_hex(content.as_bytes()));
    }
    // Losing the record costs one extra question at worst, never the export.
    if let Err(e) = write_last_export(repo_path, &last_export) {
        eprintln!("git sync: could not record the export: {e}");
    }
    Ok(())
}

fn write_last_export(repo_path: &Path, record: &HashMap<String, String>) -> Result<(), String> {
    let json = serde_json::to_vec(record).map_err(|e| e.to_string())?;
    storage::atomic_write(&last_export_path(repo_path)?, &json, None)
}

/// A URL remote can hold a password or token, and the snapshot gets pushed.
fn without_url_credentials(remote: &str) -> String {
    let Some((scheme, rest)) = remote.split_once("://") else {
        return remote.to_string();
    };
    let authority_end = rest.find('/').unwrap_or(rest.len());
    match rest[..authority_end].rfind('@') {
        Some(at) => format!("{scheme}://{}", &rest[at + 1..]),
        None => remote.to_string(),
    }
}

fn sanitize_app_data(data: &AppData) -> Result<AppData, String> {
    let mut sanitized = data.clone();
    sanitized.settings.git_sync_remote = without_url_credentials(&data.settings.git_sync_remote);
    for cred in &mut sanitized.credentials {
        match &cred.kind {
            CredentialKind::Password { .. } => {
                cred.kind = CredentialKind::Password {
                    password: String::from("[redacted]"),
                };
            }
            CredentialKind::SshKey {
                private_key_path,
                private_key: _,
                passphrase: _,
            } => {
                cred.kind = CredentialKind::SshKey {
                    private_key_path: private_key_path.clone(),
                    private_key: None,
                    passphrase: keychain::snapshot_for_credential(&cred.id)?
                        .passphrase
                        .map(|_| String::from("[redacted]")),
                };
            }
            // Nothing secret: the keys live in the agent.
            CredentialKind::Agent {} => {}
        }
    }
    Ok(sanitized)
}

fn render_summary(data: &AppData) -> String {
    let mut out = String::new();
    out.push_str(
        "Generated by SSIX. Edits in this folder are overwritten: SSIX never reads it back.\n\n",
    );
    out.push_str("# SSIX Sync Snapshot\n\n");
    out.push_str("Sanitized export for git sync. Passwords, inline private keys, and other secrets are omitted.\n\n");
    out.push_str(&format!("- Connections: {}\n", data.connections.len()));
    out.push_str(&format!("- Credentials: {}\n", data.credentials.len()));
    out.push_str(&format!("- Scripts: {}\n", data.scripts.len()));
    out.push_str(&format!("- Snippets: {}\n", data.snippets.len()));
    out.push_str(&format!("- Theme: {}\n", data.settings.theme));
    out
}

struct GitOutput {
    stdout: String,
    stderr: String,
    status: i32,
}

fn git(repo_path: &Path, args: &[&str]) -> Result<GitOutput, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git {}: {}", args.join(" "), e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let status = output.status.code().unwrap_or(-1);
    if output.status.success() {
        Ok(GitOutput {
            stdout,
            stderr,
            status,
        })
    } else {
        Err(format!("git {} failed: {}", args.join(" "), stderr.trim()))
    }
}

fn parse_status_path(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = trimmed
        .split_once(' ')
        .map(|(_, path)| path)
        .unwrap_or(trimmed)
        .trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

fn to_action_result(result: GitOutput) -> GitSyncActionResult {
    GitSyncActionResult {
        stdout: result.stdout,
        stderr: result.stderr,
        status: result.status,
    }
}

fn append_output(target: &mut String, result: &GitOutput) {
    let next = [result.stdout.trim(), result.stderr.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if next.is_empty() {
        return;
    }
    if !target.is_empty() {
        target.push('\n');
    }
    target.push_str(&next);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Connection, ConnectionKind, Credential, CredentialKind};

    #[test]
    fn test_sanitize_app_data_redacts_passwords_and_inline_keys() {
        let mut data = AppData::default();
        data.credentials.push(Credential {
            id: "cred-1".into(),
            name: "pw".into(),
            username: "root".into(),
            kind: CredentialKind::Password {
                password: "secret".into(),
            },
            is_private: false,
        });
        data.credentials.push(Credential {
            id: "cred-2".into(),
            name: "key".into(),
            username: "root".into(),
            kind: CredentialKind::SshKey {
                private_key_path: Some("~/.ssh/id_ed25519".into()),
                private_key: Some("INLINE".into()),
                passphrase: Some("secret".into()),
            },
            is_private: false,
        });

        let sanitized = sanitize_app_data(&data).unwrap();
        match &sanitized.credentials[0].kind {
            CredentialKind::Password { password } => assert_eq!(password, "[redacted]"),
            _ => panic!("expected password credential"),
        }
        match &sanitized.credentials[1].kind {
            CredentialKind::SshKey { private_key, .. } => assert!(private_key.is_none()),
            _ => panic!("expected ssh key credential"),
        }
    }

    #[test]
    fn test_parse_status_path_extracts_relative_path() {
        assert_eq!(
            parse_status_path(" M .ssix-sync/data.json"),
            Some(".ssix-sync/data.json".into())
        );
    }

    #[test]
    fn test_the_export_keeps_a_connections_folder() {
        let mut data = AppData::default();
        let mut connection = Connection::new(
            "prod".into(),
            "host".into(),
            22,
            None,
            ConnectionKind::Direct,
        );
        connection.folder = Some("prod/eu".into());
        data.connections.push(connection);
        let sanitized = sanitize_app_data(&data).unwrap();
        assert_eq!(sanitized.connections[0].folder.as_deref(), Some("prod/eu"));
        let exported = serde_json::to_string_pretty(&sanitized).unwrap();
        assert!(exported.contains(r#""folder": "prod/eu""#), "{exported}");
    }

    #[test]
    fn test_render_summary_mentions_counts() {
        let mut data = AppData::default();
        data.connections.push(Connection::new(
            "prod".into(),
            "host".into(),
            22,
            None,
            ConnectionKind::Direct,
        ));
        let summary = render_summary(&data);
        let first_line = summary.lines().next().unwrap();
        assert!(first_line.contains("Generated by SSIX"), "{first_line}");
        assert!(first_line.contains("overwritten"), "{first_line}");
        assert!(summary.contains("Connections: 1"));
        assert!(summary.contains("Snippets: 0"));
    }

    #[test]
    fn test_configured_repo_path_trims_whitespace() {
        let settings = AppSettings {
            git_sync_repo_path: Some(" /tmp/repo ".into()),
            ..AppSettings::default()
        };
        assert_eq!(
            configured_repo_path(&settings),
            Some(PathBuf::from("/tmp/repo"))
        );
    }

    #[test]
    fn test_append_output_combines_stdout_and_stderr() {
        let mut output = String::new();
        append_output(
            &mut output,
            &GitOutput {
                stdout: "ok".into(),
                stderr: "warn".into(),
                status: 0,
            },
        );
        assert_eq!(output, "ok\nwarn");
    }

    #[test]
    fn validate_git_remote_accepts_names_and_urls() {
        for ok in [
            "origin",
            "upstream",
            "git@github.com:me/cfg.git",
            "https://github.com/me/cfg.git",
            "ssh://git@host:2222/me/cfg.git",
            "/srv/git/cfg.git",
            "/Users/Greg B/sync.git",
        ] {
            assert!(validate_git_remote(ok).is_ok(), "{} should be valid", ok);
        }
    }

    #[test]
    fn validate_git_remote_rejects_options_and_control_characters() {
        for bad in [
            "",
            "   ",
            "-f",
            "--upload-pack=evil",
            "tab\there",
            "nl\nhere",
        ] {
            assert!(
                validate_git_remote(bad).is_err(),
                "{:?} should be rejected",
                bad
            );
        }
    }

    #[test]
    fn validate_git_branch_accepts_ordinary_names() {
        for ok in ["main", "feature/x-1", "release-2.0", "user@host"] {
            assert!(validate_git_branch(ok).is_ok(), "{} should be valid", ok);
        }
    }

    #[test]
    fn validate_git_branch_rejects_options_and_bad_refs() {
        for bad in [
            "",
            "   ",
            "-f",
            "--upload-pack=evil",
            "a b",
            "a..b",
            "x.lock",
            "trailing/",
            "has:colon",
            "star*",
            "tab\there",
        ] {
            assert!(
                validate_git_branch(bad).is_err(),
                "{:?} should be rejected",
                bad
            );
        }
    }

    /// A working repo, a bare remote and a second clone that plays the other
    /// machine, all driven with real git.
    struct Fixture {
        root: PathBuf,
        repo: PathBuf,
        remote: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    impl Fixture {
        /// `None` (the test then skips) only when git is not installed. The
        /// repo knows the bare remote as `origin` when `add_origin` is true;
        /// otherwise it can only be reached by URL.
        fn new(add_origin: bool) -> Option<Self> {
            if Command::new("git").arg("--version").output().is_err() {
                eprintln!("skipping: git is not installed");
                return None;
            }
            let root = std::env::temp_dir().join(format!("ssix-git-sync-{}", uuid::Uuid::new_v4()));
            let (repo, remote) = (root.join("repo"), root.join("remote.git"));
            fs::create_dir_all(&repo).unwrap();
            fs::create_dir_all(&remote).unwrap();
            run(&remote, &["init", "-q", "--bare", "--initial-branch=main"]);
            run(&repo, &["init", "-q", "--initial-branch=main"]);
            configure_identity(&repo);
            if add_origin {
                run(
                    &repo,
                    &["remote", "add", "origin", remote.to_str().unwrap()],
                );
            }
            Some(Self { root, repo, remote })
        }

        fn url(&self) -> String {
            format!("file://{}", self.remote.display())
        }

        /// Push a commit from another clone, which is what a second machine does.
        fn remote_commit(&self, branch: &str, path: &str, content: &str) {
            let other = self.root.join(format!("other-{}", uuid::Uuid::new_v4()));
            run(
                &self.root,
                &[
                    "clone",
                    "-q",
                    self.remote.to_str().unwrap(),
                    other.to_str().unwrap(),
                ],
            );
            configure_identity(&other);
            run(&other, &["checkout", "-q", "-B", branch]);
            write(&other, path, content);
            run(&other, &["add", "--", path]);
            run(&other, &["commit", "-q", "-m", "from the other machine"]);
            run(
                &other,
                &["push", "-q", "origin", &format!("HEAD:{}", branch)],
            );
        }

        fn remote_has(&self, branch: &str, path: &str) -> bool {
            git(
                &self.remote,
                &["cat-file", "-e", &format!("refs/heads/{}:{}", branch, path)],
            )
            .is_ok()
        }

        fn remote_subjects(&self, branch: &str) -> String {
            run(&self.remote, &["log", "--format=%s", branch])
        }
    }

    fn run(dir: &Path, args: &[&str]) -> String {
        git(dir, args).unwrap().stdout
    }

    fn write(dir: &Path, path: &str, content: &str) {
        let target = dir.join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, content).unwrap();
    }

    fn configure_identity(dir: &Path) {
        run(dir, &["config", "user.email", "test@ssix.test"]);
        run(dir, &["config", "user.name", "test"]);
        run(dir, &["config", "commit.gpgsign", "false"]);
    }

    /// App data whose snapshot differs for each `marker`.
    fn data_with(marker: &str, remote: &str, branch: Option<&str>) -> AppData {
        let mut data = AppData::default();
        data.settings.theme = marker.into();
        data.settings.git_sync_remote = remote.into();
        data.settings.git_sync_branch = branch.map(str::to_string);
        data
    }

    const README: &str = ".ssix-sync/README.md";
    const DATA: &str = ".ssix-sync/data.json";

    fn export_all(repo: &Path, data: &AppData) {
        export_snapshot(repo, &snapshot_files(data).unwrap(), &[]).unwrap();
    }

    fn at_risk(fixture: &Fixture, data: &AppData, discarding: bool) -> Vec<String> {
        files_at_risk(&fixture.repo, &snapshot_files(data).unwrap(), discarding).unwrap()
    }

    fn agreed(files: &[&str]) -> Vec<String> {
        files.iter().map(|file| file.to_string()).collect()
    }

    fn assert_in_step(fixture: &Fixture, data: &AppData) {
        let status = status_in(&fixture.repo, &data.settings).unwrap();
        assert_eq!((status.ahead, status.behind), (0, 0), "{status:?}");
    }

    #[test]
    fn first_sync_into_an_empty_remote_commits_and_pushes() {
        let Some(fx) = Fixture::new(true) else { return };
        let data = data_with("one", "origin", None);
        let status = status_in(&fx.repo, &data.settings).unwrap();
        assert_eq!((status.ahead, status.behind), (0, 0));

        let result = sync_in(&fx.repo, &data, &[]).unwrap();

        assert!(result
            .steps
            .iter()
            .any(|s| s.starts_with("Pushed 1 commit")));
        assert!(fx.remote_subjects("main").contains(DEFAULT_COMMIT_MESSAGE));
        assert!(fx.remote_has("main", ".ssix-sync/data.json"));
        assert_in_step(&fx, &data);
    }

    #[test]
    fn a_local_commit_counts_as_ahead_while_the_remote_branch_does_not_exist() {
        let Some(fx) = Fixture::new(true) else { return };
        let data = data_with("one", "origin", None);
        run(&fx.repo, &["commit", "-q", "--allow-empty", "-m", "first"]);
        let status = status_in(&fx.repo, &data.settings).unwrap();
        assert_eq!((status.ahead, status.behind), (1, 0));

        sync_in(&fx.repo, &data, &[]).unwrap();
        assert!(fx.remote_subjects("main").contains("first"));
    }

    #[test]
    fn an_unborn_head_takes_the_commits_a_remote_already_has() {
        let Some(fx) = Fixture::new(true) else { return };
        fx.remote_commit("main", "from-other.txt", "x");
        let data = data_with("one", "origin", None);
        run(&fx.repo, &["fetch", "-q", "origin"]);
        let status = status_in(&fx.repo, &data.settings).unwrap();
        assert_eq!((status.ahead, status.behind), (0, 1));

        sync_in(&fx.repo, &data, &[]).unwrap();
        assert!(fx.repo.join("from-other.txt").exists());
        assert!(fx.remote_has("main", ".ssix-sync/data.json"));
    }

    #[test]
    fn a_url_remote_syncs_both_ways_and_status_stays_right() {
        let Some(fx) = Fixture::new(false) else {
            return;
        };
        let url = fx.url();
        let data = data_with("one", &url, None);

        sync_in(&fx.repo, &data, &[]).unwrap();
        assert!(fx.remote_has("main", ".ssix-sync/data.json"));
        assert_in_step(&fx, &data);

        fx.remote_commit("main", "from-other.txt", "x");
        let second = sync_in(&fx.repo, &data_with("two", &url, None), &[]).unwrap();
        assert!(second
            .steps
            .iter()
            .any(|s| s.starts_with("Pulled 1 commit")));
        assert!(fx.repo.join("from-other.txt").exists());
        assert!(run(&fx.remote, &["show", "main:.ssix-sync/data.json"]).contains("two"));
        assert_in_step(&fx, &data);
    }

    #[test]
    fn a_url_remote_does_not_bring_in_its_tags() {
        let Some(fx) = Fixture::new(false) else {
            return;
        };
        fx.remote_commit("main", "from-other.txt", "x");
        run(&fx.remote, &["tag", "v1", "main"]);

        sync_in(&fx.repo, &data_with("one", &fx.url(), None), &[]).unwrap();

        assert!(fx.repo.join("from-other.txt").exists());
        assert_eq!(run(&fx.repo, &["tag", "--list"]), "");
    }

    #[test]
    fn a_url_remote_recreates_a_branch_deleted_on_the_remote() {
        let Some(fx) = Fixture::new(false) else {
            return;
        };
        let data = data_with("one", &fx.url(), None);
        sync_in(&fx.repo, &data, &[]).unwrap();
        run(&fx.remote, &["update-ref", "-d", "refs/heads/main"]);

        sync_in(&fx.repo, &data, &[]).unwrap();
        assert!(fx.remote_has("main", ".ssix-sync/data.json"));
    }

    #[test]
    fn an_unknown_remote_name_fails_sync_but_not_status() {
        let Some(fx) = Fixture::new(false) else {
            return;
        };
        let data = data_with("one", "origin", None);
        assert!(status_in(&fx.repo, &data.settings).is_ok());
        let err = sync_in(&fx.repo, &data, &[]).err().unwrap();
        assert!(err.contains("origin"), "{err}");
    }

    #[test]
    fn a_branch_override_is_what_status_compares_and_sync_pushes() {
        let Some(fx) = Fixture::new(true) else { return };
        run(&fx.repo, &["commit", "-q", "--allow-empty", "-m", "first"]);
        run(&fx.repo, &["push", "-q", "origin", "main"]);
        // Remote main moves on: only a status looking at the wrong branch sees it.
        fx.remote_commit("main", "from-other.txt", "x");
        run(&fx.repo, &["fetch", "-q", "origin"]);
        let data = data_with("one", "origin", Some("snapshots"));

        let status = status_in(&fx.repo, &data.settings).unwrap();
        assert_eq!(status.branch.as_deref(), Some("snapshots"));
        assert_eq!((status.ahead, status.behind), (1, 0));

        sync_in(&fx.repo, &data, &[]).unwrap();
        assert!(fx.remote_has("snapshots", ".ssix-sync/data.json"));
        assert!(!fx.remote_has("main", ".ssix-sync/data.json"));
        assert_in_step(&fx, &data);
    }

    #[test]
    fn a_branch_override_can_be_created_from_a_detached_head() {
        let Some(fx) = Fixture::new(true) else { return };
        run(&fx.repo, &["commit", "-q", "--allow-empty", "-m", "first"]);
        run(&fx.repo, &["checkout", "-q", "--detach"]);

        sync_in(
            &fx.repo,
            &data_with("one", "origin", Some("snapshots")),
            &[],
        )
        .unwrap();
        assert!(fx.remote_has("snapshots", ".ssix-sync/data.json"));
    }

    #[test]
    fn status_without_a_branch_still_works_on_a_detached_head() {
        let Some(fx) = Fixture::new(true) else { return };
        run(&fx.repo, &["commit", "-q", "--allow-empty", "-m", "first"]);
        run(&fx.repo, &["checkout", "-q", "--detach"]);
        let data = data_with("one", "origin", None);
        let status = status_in(&fx.repo, &data.settings).unwrap();
        assert_eq!(status.branch, None);
    }

    #[test]
    fn a_remote_commit_and_a_changed_snapshot_sync_without_getting_stuck() {
        let Some(fx) = Fixture::new(true) else { return };
        sync_in(&fx.repo, &data_with("one", "origin", None), &[]).unwrap();
        // The other machine changes the very file this one has pending, the
        // case where a pull over an exported snapshot is refused.
        fx.remote_commit("main", ".ssix-sync/data.json", "from the other machine");
        let data = data_with("two", "origin", None);
        export_all(&fx.repo, &data);

        sync_in(&fx.repo, &data, &[]).unwrap();

        let subjects = fx.remote_subjects("main");
        assert!(subjects.contains("from the other machine"), "{subjects}");
        assert!(run(&fx.remote, &["show", "main:.ssix-sync/data.json"]).contains("two"));
        assert_in_step(&fx, &data);
    }

    #[test]
    fn behind_with_a_hand_edit_stops_and_lists_it_until_the_user_agrees() {
        let Some(fx) = Fixture::new(true) else { return };
        sync_in(&fx.repo, &data_with("one", "origin", None), &[]).unwrap();
        fx.remote_commit("main", "from-other.txt", "x");
        let head = run(&fx.repo, &["rev-parse", "HEAD"]);
        // Uncommitted, but SSIX's own: this one is not listed.
        let data = data_with("two", "origin", None);
        export_all(&fx.repo, &data);
        write(&fx.repo, README, "edited by hand\n");
        let note = ".ssix-sync/mine/note.txt";
        write(&fx.repo, note, "added by hand\n");

        let stopped = sync_in(&fx.repo, &data, &[]).unwrap();

        assert_eq!(stopped.at_risk, [README, note]);
        let readme = fs::read_to_string(fx.repo.join(".ssix-sync/README.md")).unwrap();
        assert_eq!(readme, "edited by hand\n");
        assert!(fx.repo.join(".ssix-sync/mine/note.txt").exists());
        assert_eq!(run(&fx.repo, &["rev-parse", "HEAD"]), head);
        assert!(!fx.repo.join("from-other.txt").exists());

        let synced = sync_in(&fx.repo, &data, &stopped.at_risk).unwrap();

        assert!(synced.at_risk.is_empty());
        assert!(fx.repo.join("from-other.txt").exists());
        assert!(!fx.repo.join(".ssix-sync/mine/note.txt").exists());
        let readme = fs::read_to_string(fx.repo.join(".ssix-sync/README.md")).unwrap();
        assert_ne!(readme, "edited by hand\n");
        assert_in_step(&fx, &data);
    }

    /// Git for Windows converts line endings by default: a checkout writes CRLF,
    /// the next export writes LF, and git reports a change it then won't commit.
    #[test]
    fn line_ending_conversion_cannot_make_a_snapshot_look_changed() {
        let Some(fx) = Fixture::new(true) else { return };
        run(&fx.repo, &["config", "core.autocrlf", "true"]);
        let data = data_with("one", "origin", None);
        sync_in(&fx.repo, &data, &[]).unwrap();
        fx.remote_commit("main", "from-other.txt", "x");
        write(&fx.repo, README, "edited by hand\n");

        sync_in(&fx.repo, &data, &agreed(&[README])).unwrap();
        assert_in_step(&fx, &data);

        export_all(&fx.repo, &data);
        assert_eq!(run(&fx.repo, &["status", "--short"]), "");
    }

    /// Worktree bytes differ from both the blob and the export, and no record
    /// exists, so only git's own answer stops this from looking like a hand edit.
    #[test]
    fn a_clean_file_with_converted_line_endings_is_not_at_risk() {
        let Some(fx) = Fixture::new(true) else { return };
        run(&fx.repo, &["config", "core.autocrlf", "true"]);
        write(&fx.repo, DATA, "{\n  \"old\": true\n}\n");
        run(&fx.repo, &["add", "--", EXPORT_DIR]);
        run(&fx.repo, &["commit", "-q", "-m", "older export"]);
        fs::remove_file(fx.repo.join(DATA)).unwrap();
        run(&fx.repo, &["checkout", "-q", "--", EXPORT_DIR]);
        assert!(fs::read_to_string(fx.repo.join(DATA))
            .unwrap()
            .contains("\r\n"));

        let data = data_with("one", "origin", None);
        assert!(at_risk(&fx, &data, false).is_empty());
        assert!(at_risk(&fx, &data, true).is_empty());
    }

    #[test]
    fn a_clean_snapshot_or_a_branch_not_behind_never_asks() {
        let Some(fx) = Fixture::new(true) else { return };
        let data = data_with("one", "origin", None);
        sync_in(&fx.repo, &data, &[]).unwrap();
        // Behind, snapshot clean.
        fx.remote_commit("main", "from-other.txt", "x");
        assert!(sync_in(&fx.repo, &data, &[]).unwrap().at_risk.is_empty());
        assert!(fx.repo.join("from-other.txt").exists());
        // Snapshot changed, not behind.
        let data = data_with("two", "origin", None);
        export_all(&fx.repo, &data);
        assert!(sync_in(&fx.repo, &data, &[]).unwrap().at_risk.is_empty());
        assert!(run(&fx.remote, &["show", "main:.ssix-sync/data.json"]).contains("two"));
        // Behind, with SSIX's own uncommitted output: regenerated, so no question.
        fx.remote_commit("main", "from-other-2.txt", "x");
        let data = data_with("three", "origin", None);
        export_all(&fx.repo, &data);
        assert!(sync_in(&fx.repo, &data, &[]).unwrap().at_risk.is_empty());
        assert!(fx.repo.join("from-other-2.txt").exists());
        assert!(run(&fx.remote, &["show", "main:.ssix-sync/data.json"]).contains("three"));
    }

    #[test]
    fn an_added_file_is_kept_and_asks_nothing_when_no_pull_is_needed() {
        let Some(fx) = Fixture::new(true) else { return };
        let data = data_with("one", "origin", None);
        sync_in(&fx.repo, &data, &[]).unwrap();
        write(&fx.repo, ".ssix-sync/mine.txt", "added by hand\n");

        assert!(sync_in(&fx.repo, &data, &[]).unwrap().at_risk.is_empty());

        assert!(fx.repo.join(".ssix-sync/mine.txt").exists());
    }

    #[test]
    fn output_only_ever_written_by_ssix_is_not_at_risk() {
        let Some(fx) = Fixture::new(true) else { return };
        export_all(&fx.repo, &data_with("one", "origin", None));

        let newer = data_with("two", "origin", None);
        assert!(at_risk(&fx, &newer, false).is_empty());
        assert!(at_risk(&fx, &newer, true).is_empty());
    }

    #[test]
    fn a_committed_hand_edit_is_not_at_risk() {
        let Some(fx) = Fixture::new(true) else { return };
        let data = data_with("one", "origin", None);
        sync_in(&fx.repo, &data, &[]).unwrap();
        write(&fx.repo, README, "edited by hand\n");
        run(&fx.repo, &["commit", "-q", "-am", "my edit"]);

        assert!(at_risk(&fx, &data, false).is_empty());
        assert!(at_risk(&fx, &data, true).is_empty());
    }

    #[test]
    fn a_file_identical_to_the_export_is_not_at_risk() {
        let Some(fx) = Fixture::new(true) else { return };
        let data = data_with("one", "origin", None);
        // No record, never committed: only the content can clear these.
        for (path, content) in snapshot_files(&data).unwrap() {
            write(&fx.repo, &path, &content);
        }

        assert!(at_risk(&fx, &data, false).is_empty());
    }

    #[test]
    fn with_no_usable_record_an_uncommitted_file_that_differs_is_at_risk() {
        let Some(fx) = Fixture::new(true) else { return };
        export_all(&fx.repo, &data_with("one", "origin", None));
        let record = last_export_path(&fx.repo).unwrap();
        let newer = data_with("two", "origin", None);
        // `.gitattributes` never changes between exports, so it stays off the list.
        fs::remove_file(&record).unwrap();
        assert_eq!(at_risk(&fx, &newer, false), [README, DATA]);

        fs::write(&record, "not json").unwrap();
        assert_eq!(at_risk(&fx, &newer, false), [README, DATA]);

        // Once committed, git has them, record or not.
        run(&fx.repo, &["add", "--", EXPORT_DIR]);
        run(&fx.repo, &["commit", "-q", "-m", "snapshot"]);
        assert!(at_risk(&fx, &newer, false).is_empty());
    }

    #[test]
    fn a_hand_edit_changed_back_is_not_at_risk() {
        let Some(fx) = Fixture::new(true) else { return };
        let data = data_with("one", "origin", None);
        export_all(&fx.repo, &data);
        let exported = fs::read_to_string(fx.repo.join(README)).unwrap();
        let newer = data_with("two", "origin", None);

        write(&fx.repo, README, "edited by hand\n");
        assert_eq!(at_risk(&fx, &newer, false), [README]);

        write(&fx.repo, README, &exported);
        assert!(at_risk(&fx, &newer, false).is_empty());
    }

    #[test]
    fn git_ignoring_a_file_changes_nothing_about_what_is_lost() {
        let Some(fx) = Fixture::new(true) else { return };
        let data = data_with("one", "origin", None);
        let kept = ".ssix-sync/kept.log";
        fs::write(
            fx.repo.join(".git/info/exclude"),
            format!("{README}\n{kept}\n"),
        )
        .unwrap();
        write(&fx.repo, README, "edited by hand\n");
        write(&fx.repo, kept, "git clean leaves this alone\n");

        assert_eq!(at_risk(&fx, &data, false), [README]);
        assert_eq!(at_risk(&fx, &data, true), [README]);
    }

    #[test]
    fn work_outside_the_generated_files_is_at_risk_only_when_discarding() {
        let Some(fx) = Fixture::new(true) else { return };
        let data = data_with("one", "origin", None);
        let committed = ".ssix-sync/committed.txt";
        write(&fx.repo, committed, "kept in git\n");
        let gone = ".ssix-sync/gone.txt";
        write(&fx.repo, gone, "kept in git\n");
        sync_in(&fx.repo, &data, &[]).unwrap();

        // An untracked path with a space, and a tracked file with a new edit: the
        // discard takes both. A deletion it just undoes loses nothing.
        let added = ".ssix-sync/my notes/added.txt";
        write(&fx.repo, added, "added by hand\n");
        write(&fx.repo, committed, "edited, not committed\n");
        fs::remove_file(fx.repo.join(gone)).unwrap();

        assert!(at_risk(&fx, &data, false).is_empty());
        assert_eq!(at_risk(&fx, &data, true), [committed, added]);
    }

    #[test]
    fn export_stops_for_a_hand_edit_until_the_user_agrees() {
        let Some(fx) = Fixture::new(true) else { return };
        sync_in(&fx.repo, &data_with("one", "origin", None), &[]).unwrap();
        let exported = fs::read_to_string(fx.repo.join(DATA)).unwrap();
        write(&fx.repo, README, "edited by hand\n");
        let newer = data_with("two", "origin", None);

        let stopped = export_in(&fx.repo, &newer, &[]).unwrap();

        assert_eq!(stopped.at_risk, [README]);
        assert!(stopped.exported_files.is_empty());
        let readme = fs::read_to_string(fx.repo.join(README)).unwrap();
        assert_eq!(readme, "edited by hand\n");
        assert_eq!(fs::read_to_string(fx.repo.join(DATA)).unwrap(), exported);

        let done = export_in(&fx.repo, &newer, &stopped.at_risk).unwrap();

        assert!(done.at_risk.is_empty());
        assert_eq!(done.exported_files.len(), 3);
        let readme = fs::read_to_string(fx.repo.join(README)).unwrap();
        assert!(readme.starts_with("Generated by SSIX"), "{readme}");
        // What it just wrote is SSIX's own from here on.
        assert!(at_risk(&fx, &data_with("three", "origin", None), false).is_empty());
    }

    #[test]
    fn commit_stops_for_a_hand_edit_until_the_user_agrees() {
        let Some(fx) = Fixture::new(true) else { return };
        sync_in(&fx.repo, &data_with("one", "origin", None), &[]).unwrap();
        let head = run(&fx.repo, &["rev-parse", "HEAD"]);
        write(&fx.repo, README, "edited by hand\n");
        let newer = data_with("two", "origin", None);

        let stopped = commit_in(&fx.repo, &newer, "my commit", &[]).unwrap();

        assert_eq!(stopped.at_risk, [README]);
        assert_eq!(run(&fx.repo, &["rev-parse", "HEAD"]), head);
        let readme = fs::read_to_string(fx.repo.join(README)).unwrap();
        assert_eq!(readme, "edited by hand\n");
        assert_eq!(run(&fx.repo, &["diff", "--cached", "--name-only"]), "");

        let done = commit_in(&fx.repo, &newer, "my commit", &stopped.at_risk).unwrap();

        assert!(done.at_risk.is_empty());
        assert_eq!(
            run(&fx.repo, &["log", "-1", "--format=%s"]).trim(),
            "my commit"
        );
        assert!(run(&fx.repo, &["show", "HEAD:.ssix-sync/data.json"]).contains("two"));
    }

    #[test]
    fn a_sync_that_does_not_pull_stops_for_a_hand_edit_until_the_user_agrees() {
        let Some(fx) = Fixture::new(true) else { return };
        sync_in(&fx.repo, &data_with("one", "origin", None), &[]).unwrap();
        let subjects = fx.remote_subjects("main");
        let head = run(&fx.repo, &["rev-parse", "HEAD"]);
        write(&fx.repo, README, "edited by hand\n");
        let newer = data_with("two", "origin", None);

        let stopped = sync_in(&fx.repo, &newer, &[]).unwrap();

        assert_eq!(stopped.at_risk, [README]);
        assert_eq!(run(&fx.repo, &["rev-parse", "HEAD"]), head);
        assert_eq!(fx.remote_subjects("main"), subjects);
        let readme = fs::read_to_string(fx.repo.join(README)).unwrap();
        assert_eq!(readme, "edited by hand\n");

        sync_in(&fx.repo, &newer, &stopped.at_risk).unwrap();

        assert!(run(&fx.remote, &["show", "main:.ssix-sync/data.json"]).contains("two"));
        assert!(!run(&fx.remote, &["show", "main:.ssix-sync/README.md"]).contains("by hand"));
    }

    #[test]
    fn agreeing_covers_only_what_was_listed() {
        let Some(fx) = Fixture::new(true) else { return };
        let data = data_with("one", "origin", None);
        sync_in(&fx.repo, &data, &[]).unwrap();
        write(&fx.repo, README, "edited by hand\n");
        write(&fx.repo, DATA, "also edited by hand\n");
        let only_readme = agreed(&[README]);

        let export = export_in(&fx.repo, &data, &only_readme).unwrap();
        let commit = commit_in(&fx.repo, &data, "my commit", &only_readme).unwrap();
        let sync = sync_in(&fx.repo, &data, &only_readme).unwrap();

        for asked in [export.at_risk, commit.at_risk, sync.at_risk] {
            assert_eq!(asked, [README, DATA]);
        }
        let readme = fs::read_to_string(fx.repo.join(README)).unwrap();
        assert_eq!(readme, "edited by hand\n");

        // Sync on the discard path, where a file added since the answer shows up.
        fx.remote_commit("main", "from-other.txt", "x");
        write(&fx.repo, ".ssix-sync/mine.txt", "added by hand\n");
        let asked = sync_in(&fx.repo, &data, &agreed(&[README, DATA])).unwrap();
        assert_eq!(asked.at_risk, [README, DATA, ".ssix-sync/mine.txt"]);
        assert!(!fx.repo.join("from-other.txt").exists());
    }

    #[test]
    fn refreshing_the_diff_keeps_a_hand_edit_and_exports_the_rest() {
        let Some(fx) = Fixture::new(true) else { return };
        sync_in(&fx.repo, &data_with("one", "origin", None), &[]).unwrap();
        write(&fx.repo, README, "edited by hand\n");

        // Twice: the first refresh must not make the edit look like SSIX's output.
        for marker in ["two", "three"] {
            let diff = diff_in(&fx.repo, &data_with(marker, "origin", None)).unwrap();
            assert_eq!(diff.at_risk, [README]);
            assert!(
                diff.unstaged.contains("edited by hand"),
                "{}",
                diff.unstaged
            );
            let readme = fs::read_to_string(fx.repo.join(README)).unwrap();
            assert_eq!(readme, "edited by hand\n");
            let exported = fs::read_to_string(fx.repo.join(DATA)).unwrap();
            assert!(exported.contains(marker), "{exported}");
        }
        // Nor may it clear the question for the next real export.
        let stopped = export_in(&fx.repo, &data_with("three", "origin", None), &[]).unwrap();
        assert_eq!(stopped.at_risk, [README]);
    }

    #[test]
    fn refreshing_the_diff_without_a_record_keeps_a_hand_edit_at_risk() {
        let Some(fx) = Fixture::new(true) else { return };
        let data = data_with("one", "origin", None);
        export_all(&fx.repo, &data);
        fs::remove_file(last_export_path(&fx.repo).unwrap()).unwrap();
        write(&fx.repo, README, "edited by hand\n");

        assert_eq!(diff_in(&fx.repo, &data).unwrap().at_risk, [README]);
        assert_eq!(diff_in(&fx.repo, &data).unwrap().at_risk, [README]);
    }

    #[test]
    fn the_record_stays_out_of_the_snapshot_and_works_in_a_linked_worktree() {
        let Some(fx) = Fixture::new(true) else { return };
        run(&fx.repo, &["commit", "-q", "--allow-empty", "-m", "first"]);
        let linked = fx.root.join("linked");
        run(
            &fx.repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "linked",
                linked.to_str().unwrap(),
            ],
        );

        let data = data_with("one", "origin", None);
        export_all(&linked, &data);

        assert!(fx
            .repo
            .join(".git/worktrees/linked")
            .join(LAST_EXPORT_RECORD)
            .exists());
        assert!(!linked.join(EXPORT_DIR).join(LAST_EXPORT_RECORD).exists());
        let newer = snapshot_files(&data_with("two", "origin", None)).unwrap();
        assert!(files_at_risk(&linked, &newer, false).unwrap().is_empty());
    }

    #[test]
    fn failing_to_write_the_record_does_not_fail_the_export() {
        let Some(fx) = Fixture::new(true) else { return };
        // A directory where the file belongs: the rename onto it cannot succeed.
        let record = last_export_path(&fx.repo).unwrap();
        fs::create_dir_all(record.join("in-the-way")).unwrap();
        let data = data_with("one", "origin", None);

        let done = export_in(&fx.repo, &data, &[]).unwrap();

        assert_eq!(done.exported_files.len(), 3);
        assert!(fs::read_to_string(fx.repo.join(DATA))
            .unwrap()
            .contains("one"));
        assert!(record.is_dir());
    }

    /// A second machine's first Sync: no commit yet, its own snapshot already
    /// staged, and the remote has the same files.
    #[test]
    fn a_new_machine_with_a_pending_snapshot_takes_the_remote_history() {
        let Some(fx) = Fixture::new(true) else { return };
        fx.remote_commit("main", ".ssix-sync/data.json", "from the other machine");
        let data = data_with("two", "origin", None);
        export_all(&fx.repo, &data);
        run(&fx.repo, &["add", "--", EXPORT_DIR]);

        sync_in(&fx.repo, &data, &[]).unwrap();

        let subjects = fx.remote_subjects("main");
        assert!(subjects.contains("from the other machine"), "{subjects}");
        assert!(run(&fx.remote, &["show", "main:.ssix-sync/data.json"]).contains("two"));
    }

    #[test]
    fn sync_discards_only_the_snapshot_before_pulling() {
        let Some(fx) = Fixture::new(true) else { return };
        write(&fx.repo, "notes.txt", "committed\n");
        run(&fx.repo, &["add", "--", "notes.txt"]);
        run(&fx.repo, &["commit", "-q", "-m", "notes"]);
        sync_in(&fx.repo, &data_with("one", "origin", None), &[]).unwrap();
        fx.remote_commit("main", "from-other.txt", "x");

        write(&fx.repo, "notes.txt", "edited, not staged\n");
        write(&fx.repo, "-rf", "untracked, named like an option\n");
        write(
            &fx.repo,
            ".ssix-sync-keep/mine.txt",
            "untracked, similar name\n",
        );
        let data = data_with("two", "origin", None);
        export_all(&fx.repo, &data);
        let stray = ".ssix-sync/--stray";
        write(&fx.repo, stray, "added by hand\n");

        sync_in(&fx.repo, &data, &agreed(&[stray])).unwrap();

        let notes = fs::read_to_string(fx.repo.join("notes.txt")).unwrap();
        assert_eq!(notes, "edited, not staged\n");
        assert!(fx.repo.join("-rf").exists());
        assert!(fx.repo.join(".ssix-sync-keep/mine.txt").exists());
        assert!(!fx.remote_has("main", "-rf"));
        assert!(!fx.remote_has("main", ".ssix-sync/--stray"));
        assert!(run(&fx.remote, &["show", "main:.ssix-sync/data.json"]).contains("two"));
    }

    #[test]
    fn a_refused_pull_loses_nothing_and_the_next_sync_exports_again() {
        let Some(fx) = Fixture::new(true) else { return };
        write(&fx.repo, "notes.txt", "committed\n");
        run(&fx.repo, &["add", "--", "notes.txt"]);
        run(&fx.repo, &["commit", "-q", "-m", "notes"]);
        sync_in(&fx.repo, &data_with("one", "origin", None), &[]).unwrap();
        fx.remote_commit("main", "notes.txt", "from the other machine\n");
        write(&fx.repo, "notes.txt", "my edit\n");
        let data = data_with("two", "origin", None);

        assert!(sync_in(&fx.repo, &data, &[]).is_err());
        let notes = fs::read_to_string(fx.repo.join("notes.txt")).unwrap();
        assert_eq!(notes, "my edit\n");

        run(&fx.repo, &["checkout", "-q", "--", "notes.txt"]);
        sync_in(&fx.repo, &data, &[]).unwrap();
        assert!(run(&fx.remote, &["show", "main:.ssix-sync/data.json"]).contains("two"));
    }

    #[test]
    fn a_diverged_commit_is_refused_with_what_to_do_and_kept() {
        let Some(fx) = Fixture::new(true) else { return };
        sync_in(&fx.repo, &data_with("one", "origin", None), &[]).unwrap();
        commit_in(
            &fx.repo,
            &data_with("two", "origin", None),
            "my commit",
            &[],
        )
        .unwrap();
        fx.remote_commit("main", "from-other.txt", "x");
        let data = data_with("three", "origin", None);
        export_all(&fx.repo, &data);

        let err = sync_in(&fx.repo, &data, &[]).err().unwrap();

        assert!(err.contains("rebase or merge"), "{err}");
        assert!(run(&fx.repo, &["log", "--format=%s"]).contains("my commit"));
        assert!(!fx.remote_subjects("main").contains("my commit"));
        // Follow the advice: the snapshot syncs after that.
        run(&fx.repo, &["checkout", "-q", "--", ".ssix-sync"]);
        run(&fx.repo, &["pull", "-q", "--rebase", "origin", "main"]);
        sync_in(&fx.repo, &data, &[]).unwrap();
        assert!(fx.remote_subjects("main").contains("my commit"));
    }

    fn assert_only_env_stays_staged(fx: &Fixture) {
        let staged = run(&fx.repo, &["diff", "--cached", "--name-only"]);
        assert_eq!(staged.trim(), ".env");
        let committed = run(&fx.repo, &["ls-tree", "-r", "--name-only", "HEAD"]);
        assert!(!committed.contains(".env"), "{committed}");
    }

    #[test]
    fn sync_leaves_another_staged_file_staged_and_unpushed() {
        let Some(fx) = Fixture::new(true) else { return };
        write(&fx.repo, ".env", "TOKEN=secret\n");
        run(&fx.repo, &["add", "--", ".env"]);

        sync_in(&fx.repo, &data_with("one", "origin", None), &[]).unwrap();
        assert_only_env_stays_staged(&fx);
        assert!(!fx.remote_has("main", ".env"));

        // Same again with a pull on top of a repo that now has history.
        fx.remote_commit("main", "from-other.txt", "x");
        sync_in(&fx.repo, &data_with("two", "origin", None), &[]).unwrap();
        assert_only_env_stays_staged(&fx);
        assert!(!fx.remote_has("main", ".env"));
    }

    #[test]
    fn the_commit_button_leaves_another_staged_file_staged() {
        let Some(fx) = Fixture::new(true) else { return };
        write(&fx.repo, ".env", "TOKEN=secret\n");
        run(&fx.repo, &["add", "--", ".env"]);

        let data = data_with("one", "origin", None);
        commit_in(&fx.repo, &data, "-m looks like an option", &[]).unwrap();

        assert_only_env_stays_staged(&fx);
        let tree = run(&fx.repo, &["ls-tree", "-r", "--name-only", "HEAD"]);
        assert!(tree.contains(".ssix-sync/data.json"), "{tree}");
        assert_eq!(
            run(&fx.repo, &["log", "-1", "--format=%s"]).trim(),
            "-m looks like an option"
        );
    }

    #[test]
    fn a_token_in_a_url_remote_never_reaches_the_snapshot() {
        for (remote, kept) in [
            (
                "https://me:s3cret@github.com/me/cfg.git",
                "https://github.com/me/cfg.git",
            ),
            (
                "https://s3cret@github.com/me/cfg.git",
                "https://github.com/me/cfg.git",
            ),
            (
                "ssh://me:s3cret@host:2222/cfg@v1.git",
                "ssh://host:2222/cfg@v1.git",
            ),
            (
                "https://github.com/me/cfg.git",
                "https://github.com/me/cfg.git",
            ),
            ("git@github.com:me/cfg.git", "git@github.com:me/cfg.git"),
            ("origin", "origin"),
        ] {
            let mut data = AppData::default();
            data.settings.git_sync_remote = remote.to_string();
            let sanitized = sanitize_app_data(&data).unwrap();
            assert_eq!(sanitized.settings.git_sync_remote, kept);
            let exported = serde_json::to_string(&sanitized).unwrap();
            assert!(!exported.contains("s3cret"), "{remote} leaked: {exported}");
        }
    }
}
