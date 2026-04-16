# Architecture

SSX is a Tauri v2 desktop application combining a React frontend with a Rust backend.

## Frontend (React + TypeScript)

- `src/App.tsx` — root component, view routing
- `src/components/` — UI components
- `src/store/` — Zustand state stores
- `src/types/` — shared TypeScript types
- `src/lib/` — utilities and Tauri invoke wrapper

## Backend (Rust)

- `src-tauri/src/models.rs` — data models
- `src-tauri/src/storage.rs` — JSON file persistence (`~/.ssx/data.json`)
- `src-tauri/src/commands/` — Tauri command handlers

## Data Flow

UI → Zustand store → `invoke()` → Tauri command → storage → response
