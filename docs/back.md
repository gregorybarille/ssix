# Backend Guide

Built with Rust and Tauri v2.

## Structure

```
src-tauri/src/
  main.rs          # Entry point
  lib.rs           # Tauri builder, command registration
  models.rs        # Credential, Connection, AppSettings, AppData
  storage.rs       # load_data() / save_data() to ~/.ssx/data.json
  commands/
    mod.rs
    credentials.rs # get/add/update/delete_credential
    connections.rs # get/add/update/delete/clone/search_connections
    settings.rs    # get/save_settings
```

## Storage

All data is persisted as a single JSON file at `~/.ssx/data.json`.

## Commands

Each command is a plain Rust function annotated with `#[tauri::command]` and registered in `lib.rs`.
