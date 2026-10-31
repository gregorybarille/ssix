//! Saved scripts and running them on connections.
//!
//! `run_script` runs one saved script on one connection; the frontend calls
//! it once per selected host, in parallel, the way bulk SCP does.
//!
//! A run is numbered by `begin_script_run` and every host of it passes that
//! number; `cancel_script_run` moves the counter on, so each host of the
//! run, even one whose call arrives after the cancel, sees it is cancelled.

use crate::commands::blocking;
use crate::commands::ssh::{connect_session, find_connection};
use crate::logs::log_local;
use crate::models::{Script, ScriptPlatform};
use crate::remote_script::{self, ScriptResult, RUN_TIMEOUT};
use crate::storage::{load_data, with_data_mut};
use serde::Deserialize;
use std::sync::atomic::{AtomicU64, Ordering};

const NAME_MAX_CHARS: usize = 128;
const INTERPRETER_MAX_CHARS: usize = 256;
const BODY_MAX_BYTES: usize = 256 * 1024;

/// The number of the current script run; cancelling moves it on.
static CURRENT_RUN: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
pub struct ScriptInput {
    pub name: String,
    pub body: String,
    #[serde(default)]
    pub platform: ScriptPlatform,
    /// Blank means the platform's default: `sh -s` or `powershell`.
    #[serde(default)]
    pub interpreter: String,
}

/// Check `input` against the saved scripts (other than `own_id`) and
/// return it normalized: name and interpreter trimmed, the platform's
/// default interpreter filled in.
fn check_script(
    scripts: &[Script],
    own_id: Option<&str>,
    input: ScriptInput,
) -> Result<ScriptInput, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("Script name is required".to_string());
    }
    if name.chars().count() > NAME_MAX_CHARS {
        return Err(format!(
            "Script name must be {} characters or fewer",
            NAME_MAX_CHARS
        ));
    }
    if scripts
        .iter()
        .any(|s| s.name == name && Some(s.id.as_str()) != own_id)
    {
        return Err(format!("A script named \"{}\" already exists", name));
    }

    let interpreter = match input.interpreter.trim() {
        "" => input.platform.default_interpreter().to_string(),
        other => other.to_string(),
    };
    if interpreter.chars().count() > INTERPRETER_MAX_CHARS {
        return Err(format!(
            "Interpreter must be {} characters or fewer",
            INTERPRETER_MAX_CHARS
        ));
    }
    if interpreter.chars().any(char::is_control) {
        return Err("Interpreter must be a single line".to_string());
    }
    // A Windows command line is read by cmd or PowerShell, depending on
    // the server's default shell, and they quote differently: allow only
    // what both read as one plain word.
    if input.platform == ScriptPlatform::Windows
        && !interpreter
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.-:\\/".contains(c))
    {
        return Err("PowerShell must be a program name or a path without spaces".to_string());
    }

    if input.body.trim().is_empty() {
        return Err("Script is empty".to_string());
    }
    if input.body.len() > BODY_MAX_BYTES {
        return Err(format!(
            "Script must be {} KiB or smaller",
            BODY_MAX_BYTES / 1024
        ));
    }

    Ok(ScriptInput {
        name,
        body: input.body,
        platform: input.platform,
        interpreter,
    })
}

#[tauri::command]
pub fn get_scripts() -> Result<Vec<Script>, String> {
    Ok(load_data()?.scripts)
}

#[tauri::command]
pub async fn add_script(input: ScriptInput) -> Result<Script, String> {
    blocking(move || add_script_sync(input)).await
}

fn add_script_sync(input: ScriptInput) -> Result<Script, String> {
    with_data_mut(|data| {
        let input = check_script(&data.scripts, None, input)?;
        let script = Script::new(input.name, input.body, input.platform, input.interpreter);
        data.scripts.push(script.clone());
        Ok(script)
    })
}

#[tauri::command]
pub async fn update_script(id: String, input: ScriptInput) -> Result<Script, String> {
    blocking(move || update_script_sync(id, input)).await
}

fn update_script_sync(id: String, input: ScriptInput) -> Result<Script, String> {
    with_data_mut(|data| {
        let input = check_script(&data.scripts, Some(&id), input)?;
        let script = data
            .scripts
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| "Script not found".to_string())?;
        script.name = input.name;
        script.body = input.body;
        script.platform = input.platform;
        script.interpreter = input.interpreter;
        Ok(script.clone())
    })
}

#[tauri::command]
pub async fn delete_script(id: String) -> Result<(), String> {
    blocking(move || {
        with_data_mut(|data| {
            data.scripts.retain(|s| s.id != id);
            Ok(())
        })
    })
    .await
}

/// Number a new run, to pass to `run_script` for each of its hosts.
#[tauri::command]
pub fn begin_script_run() -> u64 {
    CURRENT_RUN.load(Ordering::SeqCst)
}

/// Stop every host of run `run` that is still going. A stale number (a run
/// already cancelled) changes nothing.
#[tauri::command]
pub fn cancel_script_run(run: u64) {
    let _ = CURRENT_RUN.compare_exchange(run, run + 1, Ordering::SeqCst, Ordering::SeqCst);
}

fn is_cancelled(run: u64) -> bool {
    CURRENT_RUN.load(Ordering::SeqCst) != run
}

#[tauri::command]
pub async fn run_script(
    script_id: String,
    connection_id: String,
    run: u64,
) -> Result<ScriptResult, String> {
    blocking(move || run_script_sync(&script_id, &connection_id, run)).await
}

fn run_script_sync(script_id: &str, connection_id: &str, run: u64) -> Result<ScriptResult, String> {
    let (data, conn) = find_connection(connection_id)?;
    let script = data
        .scripts
        .iter()
        .find(|s| s.id == script_id)
        .cloned()
        .ok_or_else(|| "Script not found".to_string())?;

    let outcome = connect_session(&data, &conn, "Running a script").and_then(|ssh| {
        remote_script::run(
            &ssh.session,
            script.platform,
            &script.interpreter,
            &script.body,
            RUN_TIMEOUT,
            &|| is_cancelled(run),
        )
    });
    match &outcome {
        Ok(result) => log_local(
            if result.exit_code == Some(0) {
                "info"
            } else {
                "warn"
            },
            "script",
            format!(
                "\"{}\" on {}: {} in {} ms",
                script.name,
                conn.name,
                describe_end(result),
                result.duration_ms
            ),
        ),
        Err(e) => log_local(
            "error",
            "script",
            format!("\"{}\" on {}: {}", script.name, conn.name, e),
        ),
    }
    outcome
}

fn describe_end(result: &ScriptResult) -> String {
    if result.cancelled {
        return "cancelled".to_string();
    }
    if result.timed_out {
        return "stopped at the time limit".to_string();
    }
    match (&result.exit_signal, result.exit_code) {
        (Some(signal), _) => format!("killed by SIG{}", signal),
        (None, Some(code)) => format!("exit {}", code),
        (None, None) => "no exit status".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::with_isolated_data_dir;

    fn input(name: &str, body: &str, interpreter: &str) -> ScriptInput {
        ScriptInput {
            name: name.to_string(),
            body: body.to_string(),
            platform: ScriptPlatform::Posix,
            interpreter: interpreter.to_string(),
        }
    }

    fn windows(interpreter: &str) -> ScriptInput {
        ScriptInput {
            platform: ScriptPlatform::Windows,
            ..input("w", "Get-Date", interpreter)
        }
    }

    #[test]
    fn add_trims_and_fills_the_default_interpreter() {
        with_isolated_data_dir(|| {
            let s = add_script_sync(input("  uptime  ", "uptime\n", " ")).unwrap();
            assert_eq!(s.name, "uptime");
            assert_eq!(s.interpreter, "sh -s");
            assert_eq!(get_scripts().unwrap().len(), 1);
        });
    }

    #[test]
    fn names_are_unique_but_a_script_keeps_its_own() {
        with_isolated_data_dir(|| {
            let a = add_script_sync(input("a", "true", "")).unwrap();
            add_script_sync(input("b", "true", "")).unwrap();
            let err = add_script_sync(input("a", "true", "")).unwrap_err();
            assert!(err.contains("already exists"), "got: {}", err);
            let err = update_script_sync(a.id.clone(), input("b", "true", "")).unwrap_err();
            assert!(err.contains("already exists"), "got: {}", err);

            let renamed = update_script_sync(a.id.clone(), input("a", "id", "bash -s")).unwrap();
            assert_eq!(renamed.body, "id");
            assert_eq!(renamed.interpreter, "bash -s");
        });
    }

    #[test]
    fn rejects_bad_fields() {
        let cases = [
            (input(" ", "true", ""), "name is required"),
            (input(&"n".repeat(129), "true", ""), "128 characters"),
            (input("x", " \n", ""), "empty"),
            (input("x", &"a".repeat(BODY_MAX_BYTES + 1), ""), "KiB"),
            (input("x", "true", "sh -s\nrm -rf /"), "single line"),
            (input("x", "true", &"s".repeat(257)), "256 characters"),
        ];
        for (case, needle) in cases {
            let err = check_script(&[], None, case).err().unwrap();
            assert!(err.contains(needle), "{} not in {}", needle, err);
        }
    }

    #[test]
    fn windows_scripts_default_to_powershell_and_take_one_word() {
        let s = check_script(&[], None, windows("")).unwrap();
        assert_eq!(s.interpreter, "powershell");
        assert_eq!(s.platform, ScriptPlatform::Windows);
        for ok in ["pwsh", r"C:\tools\pwsh.exe", "C:/PS7/pwsh.exe"] {
            assert!(check_script(&[], None, windows(ok)).is_ok(), "{}", ok);
        }
        for bad in [
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            "pwsh & calc",
            "\"pwsh\"",
            "pwsh;calc",
        ] {
            let err = check_script(&[], None, windows(bad)).unwrap_err();
            assert!(err.contains("without spaces"), "{}: {}", bad, err);
        }
        // A POSIX interpreter may still be any command line.
        assert!(check_script(&[], None, input("p", "true", "sudo -u 'a b' sh -s")).is_ok());
    }

    #[test]
    fn update_and_delete_a_script() {
        with_isolated_data_dir(|| {
            let err = update_script_sync("missing".into(), input("x", "true", "")).unwrap_err();
            assert_eq!(err, "Script not found");
            let s = add_script_sync(input("x", "true", "")).unwrap();
            tauri::async_runtime::block_on(delete_script(s.id)).unwrap();
            assert!(get_scripts().unwrap().is_empty());
        });
    }

    #[test]
    fn run_refuses_unknown_scripts_and_local_forwards() {
        with_isolated_data_dir(|| {
            let err = run_script_sync("s", "missing", 0).unwrap_err();
            assert_eq!(err, "Connection not found");

            let forward = crate::models::Connection::new(
                "fwd".into(),
                "h".into(),
                22,
                None,
                crate::models::ConnectionKind::PortForward {
                    gateway_host: "gw".into(),
                    gateway_port: 22,
                    gateway_credential_id: "c".into(),
                    local_port: 8080,
                    destination_host: "db".into(),
                    destination_port: 5432,
                },
            );
            let conn_id = forward.id.clone();
            with_data_mut(|data| {
                data.connections.push(forward);
                Ok(())
            })
            .unwrap();
            let err = run_script_sync("missing", &conn_id, 0).unwrap_err();
            assert_eq!(err, "Script not found");

            let script = add_script_sync(input("x", "true", "")).unwrap();
            let err = run_script_sync(&script.id, &conn_id, 0).unwrap_err();
            assert!(err.contains("only available for direct"), "got: {}", err);
        });
    }

    #[test]
    fn describe_end_covers_each_ending() {
        let base = ScriptResult {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: Some(3),
            exit_signal: None,
            duration_ms: 1,
            truncated: false,
            timed_out: false,
            cancelled: false,
        };
        assert_eq!(describe_end(&base), "exit 3");
        let killed = ScriptResult {
            exit_code: None,
            exit_signal: Some("TERM".into()),
            ..base.clone()
        };
        assert_eq!(describe_end(&killed), "killed by SIGTERM");
        let stopped = ScriptResult {
            exit_code: None,
            timed_out: true,
            ..base.clone()
        };
        assert_eq!(describe_end(&stopped), "stopped at the time limit");
        let cancelled = ScriptResult {
            exit_code: None,
            exit_signal: Some("TERM".into()),
            cancelled: true,
            ..base.clone()
        };
        assert_eq!(describe_end(&cancelled), "cancelled");
    }

    /// Cancelling reaches every host of the run, including one that starts
    /// after the cancel, and never a later run.
    #[test]
    fn cancel_stops_only_its_own_run() {
        let run = begin_script_run();
        assert!(!is_cancelled(run));
        cancel_script_run(run);
        assert!(is_cancelled(run));
        let next = begin_script_run();
        assert!(!is_cancelled(next));
        cancel_script_run(run);
        assert!(
            !is_cancelled(next),
            "a stale cancel must not stop the next run"
        );
        cancel_script_run(next);
    }
}
