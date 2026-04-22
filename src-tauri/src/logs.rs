//! In-memory ring buffer of backend log entries.
//!
//! Each call to [`log`] appends an entry and emits an `app-log` Tauri event
//! so the frontend can stream updates live. The buffer is capped at
//! [`MAX_ENTRIES`]; the oldest entry is evicted when full.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
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

static BUFFER: Lazy<Mutex<VecDeque<LogEntry>>> =
    Lazy::new(|| Mutex::new(VecDeque::with_capacity(MAX_ENTRIES)));

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
#[allow(dead_code)]
pub fn log_local(level: &str, source: &str, message: impl Into<String>) {
    push(LogEntry {
        ts: now_ms(),
        level: level.to_string(),
        source: source.to_string(),
        message: message.into(),
    });
}

fn push(entry: LogEntry) {
    let mut buf = BUFFER.lock().unwrap();
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

    fn reset() {
        BUFFER.lock().unwrap().clear();
    }

    #[test]
    fn test_push_and_get() {
        reset();
        log_local("info", "test", "hello");
        log_local("warn", "test", "world");
        let logs = BUFFER.lock().unwrap();
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].message, "hello");
        assert_eq!(logs[1].level, "warn");
    }

    #[test]
    fn test_ring_buffer_evicts_oldest() {
        reset();
        for i in 0..(MAX_ENTRIES + 50) {
            log_local("info", "test", format!("msg-{i}"));
        }
        let logs = BUFFER.lock().unwrap();
        assert_eq!(logs.len(), MAX_ENTRIES);
        assert_eq!(logs.front().unwrap().message, format!("msg-{}", 50));
        assert_eq!(
            logs.back().unwrap().message,
            format!("msg-{}", MAX_ENTRIES + 49)
        );
    }

    #[test]
    fn test_clear() {
        reset();
        log_local("info", "test", "x");
        log_local("info", "test", "y");
        BUFFER.lock().unwrap().clear();
        assert!(BUFFER.lock().unwrap().is_empty());
    }
}
