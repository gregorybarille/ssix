use crate::keychain;
use crate::models::{AppData, AppSettings, CredentialKind};
use crate::storage;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const EXPORT_DIR: &str = ".ssx-sync";
const DATA_FILE: &str = "data.json";
const SUMMARY_FILE: &str = "README.md";
const DEFAULT_COMMIT_MESSAGE: &str = "sync ssx config snapshot";

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
pub struct GitSyncDiff {
    pub staged: String,
    pub unstaged: String,
}

#[derive(Debug, Serialize)]
pub struct GitSyncSnapshot {
    pub repo_path: String,
    pub exported_files: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct GitSyncActionResult {
    pub stdout: String,
    pub stderr: String,
    pub status: i32,
}

#[derive(Debug, Serialize)]
pub struct GitSyncRunResult {
    pub steps: Vec<String>,
    pub output: GitSyncActionResult,
}

#[derive(Debug, Deserialize)]
pub struct GitSyncCommitInput {
    pub message: String,
}

#[tauri::command]
pub fn git_sync_status() -> Result<GitSyncStatus, String> {
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
    let branch = current_branch(&repo_path)?;
    let remote = data.settings.git_sync_remote.trim().to_string();
    let porcelain = git(&repo_path, &["status", "--short", EXPORT_DIR])?;
    let changed_files = porcelain
        .stdout
        .lines()
        .filter_map(parse_status_path)
        .collect::<Vec<_>>();
    let has_local_changes = !changed_files.is_empty();
    let (ahead, behind) = ahead_behind(&repo_path, &remote, branch.as_deref())?;

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
pub fn git_sync_export_snapshot() -> Result<GitSyncSnapshot, String> {
    let data = storage::load_data()?;
    let repo_path = configured_repo_path(&data.settings)
        .ok_or_else(|| "Configure a git sync repository path in Settings first".to_string())?;
    ensure_repo_exists(&repo_path)?;
    export_snapshot(&repo_path, &data)?;

    Ok(GitSyncSnapshot {
        repo_path: repo_path.display().to_string(),
        exported_files: vec![
            format!("{}/{}", EXPORT_DIR, DATA_FILE),
            format!("{}/{}", EXPORT_DIR, SUMMARY_FILE),
        ],
    })
}

#[tauri::command]
pub fn git_sync_diff() -> Result<GitSyncDiff, String> {
    let data = storage::load_data()?;
    let repo_path = configured_repo_path(&data.settings)
        .ok_or_else(|| "Configure a git sync repository path in Settings first".to_string())?;
    ensure_repo_exists(&repo_path)?;
    export_snapshot(&repo_path, &data)?;

    let unstaged = git(&repo_path, &["diff", "--", EXPORT_DIR])?.stdout;
    let staged = git(&repo_path, &["diff", "--cached", "--", EXPORT_DIR])?.stdout;
    Ok(GitSyncDiff { staged, unstaged })
}

#[tauri::command]
pub fn git_sync_fetch() -> Result<GitSyncActionResult, String> {
    let data = storage::load_data()?;
    let repo_path = configured_repo_path(&data.settings)
        .ok_or_else(|| "Configure a git sync repository path in Settings first".to_string())?;
    ensure_repo_exists(&repo_path)?;
    let remote = data.settings.git_sync_remote.trim();
    let result = git(&repo_path, &["fetch", remote])?;
    Ok(to_action_result(result))
}

#[tauri::command]
pub fn git_sync_pull() -> Result<GitSyncActionResult, String> {
    let data = storage::load_data()?;
    let repo_path = configured_repo_path(&data.settings)
        .ok_or_else(|| "Configure a git sync repository path in Settings first".to_string())?;
    ensure_repo_exists(&repo_path)?;
    let remote = data.settings.git_sync_remote.trim();
    let branch = branch_name(&repo_path, &data.settings)?;
    let result = git(&repo_path, &["pull", "--ff-only", remote, &branch])?;
    Ok(to_action_result(result))
}

#[tauri::command]
pub fn git_sync_push() -> Result<GitSyncActionResult, String> {
    let data = storage::load_data()?;
    let repo_path = configured_repo_path(&data.settings)
        .ok_or_else(|| "Configure a git sync repository path in Settings first".to_string())?;
    ensure_repo_exists(&repo_path)?;
    export_snapshot(&repo_path, &data)?;
    let remote = data.settings.git_sync_remote.trim();
    let branch = branch_name(&repo_path, &data.settings)?;
    let result = git(&repo_path, &["push", remote, &format!("HEAD:{}", branch)])?;
    Ok(to_action_result(result))
}

#[tauri::command]
pub fn git_sync_commit(input: GitSyncCommitInput) -> Result<GitSyncActionResult, String> {
    let data = storage::load_data()?;
    let repo_path = configured_repo_path(&data.settings)
        .ok_or_else(|| "Configure a git sync repository path in Settings first".to_string())?;
    ensure_repo_exists(&repo_path)?;
    export_snapshot(&repo_path, &data)?;

    let message = input.message.trim();
    if message.is_empty() {
        return Err("Commit message is required".to_string());
    }

    git(&repo_path, &["add", EXPORT_DIR])?;
    let status = git(&repo_path, &["status", "--short", EXPORT_DIR])?;
    if status.stdout.trim().is_empty() {
        return Ok(GitSyncActionResult {
            stdout: "No changes to commit.".to_string(),
            stderr: String::new(),
            status: 0,
        });
    }

    let result = git(&repo_path, &["commit", "-m", message])?;
    Ok(to_action_result(result))
}

#[tauri::command]
pub fn git_sync_run() -> Result<GitSyncRunResult, String> {
    let data = storage::load_data()?;
    let repo_path = configured_repo_path(&data.settings)
        .ok_or_else(|| "Configure a git sync repository path in Settings first".to_string())?;
    ensure_repo_exists(&repo_path)?;

    let remote = data.settings.git_sync_remote.trim().to_string();
    let branch = branch_name(&repo_path, &data.settings)?;
    let mut steps = Vec::new();
    let mut combined_output = String::new();

    export_snapshot(&repo_path, &data)?;
    steps.push("Exported sanitized snapshot".to_string());

    let fetch = git(&repo_path, &["fetch", &remote])?;
    append_output(&mut combined_output, &fetch);
    steps.push(format!("Fetched {}", remote));

    let (_, behind_before_pull) = ahead_behind(&repo_path, &remote, Some(&branch))?;
    if behind_before_pull > 0 {
        let pull = git(&repo_path, &["pull", "--ff-only", &remote, &branch])?;
        append_output(&mut combined_output, &pull);
        steps.push(format!("Pulled {} commit(s) from {}/{}", behind_before_pull, remote, branch));
    }

    let status = git(&repo_path, &["status", "--short", EXPORT_DIR])?;
    let changed_files = status
        .stdout
        .lines()
        .filter_map(parse_status_path)
        .collect::<Vec<_>>();
    if !changed_files.is_empty() {
        git(&repo_path, &["add", EXPORT_DIR])?;
        let commit = git(&repo_path, &["commit", "-m", DEFAULT_COMMIT_MESSAGE])?;
        append_output(&mut combined_output, &commit);
        steps.push(format!("Committed {} changed file(s)", changed_files.len()));
    } else {
        steps.push("No local snapshot changes to commit".to_string());
    }

    let (ahead_after_commit, _) = ahead_behind(&repo_path, &remote, Some(&branch))?;
    if ahead_after_commit > 0 {
        let push = git(&repo_path, &["push", &remote, &format!("HEAD:{}", branch)])?;
        append_output(&mut combined_output, &push);
        steps.push(format!("Pushed {} commit(s) to {}/{}", ahead_after_commit, remote, branch));
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
    })
}

fn configured_repo_path(settings: &AppSettings) -> Option<PathBuf> {
    settings
        .git_sync_repo_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

fn ensure_repo_exists(repo_path: &Path) -> Result<(), String> {
    if !repo_path.exists() {
        return Err(format!("Git sync repository does not exist: {}", repo_path.display()));
    }
    if !repo_path.join(".git").exists() {
        return Err(format!("Directory is not a git repository: {}", repo_path.display()));
    }
    Ok(())
}

fn branch_name(repo_path: &Path, settings: &AppSettings) -> Result<String, String> {
    if let Some(branch) = settings
        .git_sync_branch
        .as_deref()
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
    {
        return Ok(branch.to_string());
    }
    current_branch(repo_path)?.ok_or_else(|| "Could not determine current git branch".to_string())
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

fn ahead_behind(repo_path: &Path, remote: &str, branch: Option<&str>) -> Result<(u32, u32), String> {
    let Some(branch) = branch else {
        return Ok((0, 0));
    };
    let remote_ref = format!("{}/{}", remote, branch);
    let result = git(repo_path, &["rev-list", "--left-right", "--count", &format!("HEAD...{}", remote_ref)])?;
    let mut parts = result.stdout.split_whitespace();
    let ahead = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    let behind = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    Ok((ahead, behind))
}

fn export_snapshot(repo_path: &Path, data: &AppData) -> Result<(), String> {
    let export_dir = repo_path.join(EXPORT_DIR);
    fs::create_dir_all(&export_dir).map_err(|e| e.to_string())?;

    let sanitized = sanitize_app_data(data);
    let data_json = serde_json::to_string_pretty(&sanitized).map_err(|e| e.to_string())?;
    // Audit-4 L1: route both writes through atomic_write so a crash
    // during the export can't leave a half-written data.json or
    // SUMMARY.md that subsequent git operations would commit as a
    // partial snapshot.
    crate::storage::atomic_write(&export_dir.join(DATA_FILE), data_json.as_bytes(), None)
        .map_err(|e| e.to_string())?;
    crate::storage::atomic_write(
        &export_dir.join(SUMMARY_FILE),
        render_summary(&sanitized).as_bytes(),
        None,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn sanitize_app_data(data: &AppData) -> AppData {
    let mut sanitized = data.clone();
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
                    passphrase: keychain::get_passphrase(&cred.id).map(|_| String::from("[redacted]")),
                };
            }
        }
    }
    sanitized
}

fn render_summary(data: &AppData) -> String {
    let mut out = String::new();
    out.push_str("# SSX Sync Snapshot\n\n");
    out.push_str("Sanitized export for git sync. Passwords, inline private keys, and other secrets are omitted.\n\n");
    out.push_str(&format!("- Connections: {}\n", data.connections.len()));
    out.push_str(&format!("- Credentials: {}\n", data.credentials.len()));
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
        Ok(GitOutput { stdout, stderr, status })
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
        target.push_str("\n");
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

        let sanitized = sanitize_app_data(&data);
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
        assert_eq!(parse_status_path(" M .ssx-sync/data.json"), Some(".ssx-sync/data.json".into()));
    }

    #[test]
    fn test_render_summary_mentions_counts() {
        let mut data = AppData::default();
        data.connections.push(Connection::new("prod".into(), "host".into(), 22, None, ConnectionKind::Direct));
        let summary = render_summary(&data);
        assert!(summary.contains("Connections: 1"));
    }

    #[test]
    fn test_configured_repo_path_trims_whitespace() {
        let settings = AppSettings {
            git_sync_repo_path: Some(" /tmp/repo ".into()),
            ..AppSettings::default()
        };
        assert_eq!(configured_repo_path(&settings), Some(PathBuf::from("/tmp/repo")));
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
}
