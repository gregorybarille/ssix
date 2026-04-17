# Frontend Guide

Built with React 18, TypeScript, Vite, Tailwind CSS, and Radix UI primitives.

## Structure

```
src/
  App.tsx                  # Root component
  components/
    ui/                    # Radix-based primitives (button, input, dialog…)
    ConnectionList.tsx
    ConnectionForm.tsx
    CredentialList.tsx
    CredentialForm.tsx
    SearchBar.tsx
    SettingsPanel.tsx
    Sidebar.tsx
  store/
    useConnectionsStore.ts
    useCredentialsStore.ts
    useSettingsStore.ts
  types/index.ts
  lib/
    utils.ts               # cn() helper
    tauri.ts               # invoke() wrapper
  styles/globals.css
  test/                    # Vitest + Testing Library tests
```

## State Management

Zustand stores handle async Tauri calls and local state updates optimistically.

## Styling

Tailwind CSS with CSS variables for theming (dark mode by default).
