//! In-memory ring buffer of backend log entries.
//!
//! Each call to [`log`] appends an entry and emits an `app-log` Tauri event
//! so the frontend can stream updates live. The buffer is capped at
//! [`MAX_ENTRIES`]; the oldest entry is evicted when full.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use tauri::{AppHandle, Emitter};

pub const MAX_ENTRIES: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LogEntry {
    /// Unix timestamp in milliseconds.
    pub ts: u64,
    /// "info", "warn", "error", or "debug".
    pub level: String,
    /// Logical source (e.g. "ssh", "tunnel", "system").
    pub source: String,
    pub message: String,
}

static BUFFER: LazyLock<Mutex<VecDeque<LogEntry>>> =
    LazyLock::new(|| Mutex::new(VecDeque::with_capacity(MAX_ENTRIES)));

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Push an entry onto the ring buffer and emit `app-log`.
///
/// Safe to call from any thread, including SSH worker threads.
pub fn log(app: &AppHandle, level: &str, source: &str, message: impl Into<String>) {
    let entry = LogEntry {
        ts: now_ms(),
        level: level.to_string(),
        source: source.to_string(),
        message: message.into(),
    };
    push(entry.clone());
    let _ = app.emit("app-log", entry);
}

/// Variant for code paths that don't have an `AppHandle` (e.g. helpers used
/// before a session has been wired). Stored but no event emitted.
pub fn log_local(level: &str, source: &str, message: impl Into<String>) {
    push(LogEntry {
        ts: now_ms(),
        level: level.to_string(),
        source: source.to_string(),
        message: message.into(),
    });
}

fn push(entry: LogEntry) {
    push_into(&mut BUFFER.lock().unwrap_or_else(|e| e.into_inner()), entry);
}

fn push_into(buf: &mut VecDeque<LogEntry>, entry: LogEntry) {
    if buf.len() >= MAX_ENTRIES {
        buf.pop_front();
    }
    buf.push_back(entry);
}

#[tauri::command]
pub fn get_logs() -> Result<Vec<LogEntry>, String> {
    let buf = BUFFER.lock().map_err(|e| e.to_string())?;
    Ok(buf.iter().cloned().collect())
}

#[tauri::command]
pub fn clear_logs() -> Result<(), String> {
    let mut buf = BUFFER.lock().map_err(|e| e.to_string())?;
    buf.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Tests in other modules log through the same global buffer while these
    // run, so these only look at their own entries (by source) or use a
    // local buffer. `test_clear` empties the buffer, so the tests that read
    // it take turns through `SHARED`.
    static SHARED: Mutex<()> = Mutex::new(());

    fn own_entries(source: &str) -> Vec<LogEntry> {
        get_logs()
            .unwrap()
            .into_iter()
            .filter(|e| e.source == source)
            .collect()
    }

    #[test]
    fn test_push_and_get() {
        let _turn = SHARED.lock().unwrap_or_else(|e| e.into_inner());
        log_local("info", "test-push-and-get", "hello");
        log_local("warn", "test-push-and-get", "world");
        let logs = own_entries("test-push-and-get");
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].message, "hello");
        assert_eq!(logs[1].level, "warn");
    }

    #[test]
    fn test_ring_buffer_evicts_oldest() {
        let mut buf = VecDeque::new();
        for i in 0..(MAX_ENTRIES + 50) {
            push_into(
                &mut buf,
                LogEntry {
                    ts: 0,
                    level: "info".to_string(),
                    source: "test".to_string(),
                    message: format!("msg-{i}"),
                },
            );
        }
        assert_eq!(buf.len(), MAX_ENTRIES);
        assert_eq!(buf.front().unwrap().message, format!("msg-{}", 50));
        assert_eq!(
            buf.back().unwrap().message,
            format!("msg-{}", MAX_ENTRIES + 49)
        );
    }

    #[test]
    fn test_clear() {
        let _turn = SHARED.lock().unwrap_or_else(|e| e.into_inner());
        log_local("info", "test-clear", "x");
        clear_logs().unwrap();
        assert!(own_entries("test-clear").is_empty());
    }
}
