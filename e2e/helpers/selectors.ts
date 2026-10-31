/**
 * Single source of truth for `data-testid` selectors used by E2E specs.
 *
 * The corresponding attributes are added to React components in the
 * "data-testid additions" patch. Keeping them centralised here means
 * a refactor that renames a testid only requires editing this file.
 */

/**
 * Mirrors the slugifyTagId helper in TagGroupGrid.tsx — must stay
 * identical so selectors match the data-testid values rendered by the
 * component. Convert a tag label to a safe CSS-selector fragment.
 */
function slugifyTagId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const sel = {
  // Top-level navigation
  sidebar: '[data-testid="sidebar"]',
  navConnections: '[data-testid="nav-connections"]',
  navCredentials: '[data-testid="nav-credentials"]',
  navForwards: '[data-testid="nav-forwards"]',
  navSettings: '[data-testid="nav-settings"]',
  navGitSync: '[data-testid="nav-git-sync"]',
  navLogs: '[data-testid="nav-logs"]',
  navScripts: '[data-testid="nav-scripts"]',

  // The right-hand column every editor, SCP panel and confirmation opens in.
  appPanelSlot: '[data-testid="app-panel-slot"]',

  // Logs view: one row per entry, with `data-level` (info, warn, debug…).
  logEntry: '[data-testid="log-entry"]',

  // Connection list (renders as either `connection-grid` or
  // `connection-list-rows`; specs use the row testid pattern).
  connectionList: '[data-testid="connection-grid"], [data-testid="connection-list-rows"]',
  connectionRow: (id: string) => `[data-testid="connection-row-${id}"]`,
  connectionRowByName: (name: string) =>
    `[data-testid^="connection-row-"][data-name="${name}"]`,
  addConnectionButton: '[data-testid="add-connection-button"]',
  // Scoped under a connection row (see connectionRowByName).
  connectionRowCloneButton: '[data-testid^="clone-connection-"]',
  connectionSearchInput: '[data-testid="connection-search-input"]',
  connectionSearchClear: '[data-testid="connection-search-clear"]',

  // Connection form
  connectionForm: '[data-testid="connection-form"]',
  connectionFormName: '[data-testid="connection-form-name"]',
  connectionFormHost: '[data-testid="connection-form-host"]',
  connectionFormPort: '[data-testid="connection-form-port"]',
  connectionFormCredential: '[data-testid="connection-form-credential"]',
  connectionFormCredentialError: '[data-testid="connection-form-credential-error"]',
  // Inline Password authentication tab and its fields.
  connectionFormAuthPassword: '[data-testid="connection-form-auth-password"]',
  connectionFormInlineUsername: '[data-testid="connection-form-inline-username"]',
  connectionFormInlinePassword: '[data-testid="connection-form-inline-password"]',
  connectionFormSaveCredential: '[data-testid="connection-form-save-credential"]',
  connectionFormSaveCredentialName: '[data-testid="connection-form-save-credential-name"]',
  // Form-level error shown when a save is refused.
  connectionFormError: '[data-testid="connection-form-error"]',
  connectionFormKindDirect: '[data-testid="connection-form-kind-direct"]',
  connectionFormKindJumpHost: '[data-testid="connection-form-kind-jumphost"]',
  connectionFormKindLocalForward: '[data-testid="connection-form-kind-localforward"]',
  connectionFormHopHost: '[data-testid="connection-form-hop-host"]',
  connectionFormHopPort: '[data-testid="connection-form-hop-port"]',
  connectionFormHopCredential: '[data-testid="connection-form-hop-credential"]',
  connectionFormTargetHost: '[data-testid="connection-form-target-host"]',
  connectionFormTargetPort: '[data-testid="connection-form-target-port"]',
  // The auth-section credential picker. In Direct mode it's *the*
  // credential. In jump host mode it is the target's credential (the
  // jump host has its own picker, see HopCredential).
  connectionFormTargetCredential: '[data-testid="connection-form-credential"]',
  connectionFormLocalPort: '[data-testid="connection-form-local-port"]',
  connectionFormVerbosity: '[data-testid="connection-form-verbosity"]',
  connectionFormProxyCommand: '[data-testid="connection-form-proxy-command"]',
  // Only rendered on Windows.
  connectionFormProxyWsl: '[data-testid="connection-form-proxy-wsl"]',
  connectionFormSubmit: '[data-testid="connection-form-submit"]',
  connectionFormCancel: '[data-testid="connection-form-cancel"]',

  // Credential list / form
  credentialList: '[data-testid="credential-grid"], [data-testid="credential-list-rows"]',
  credentialRowByName: (name: string) =>
    `[data-testid^="credential-row-"][data-name="${name}"]`,
  addCredentialButton: '[data-testid="add-credential-button"]',
  credentialForm: '[data-testid="credential-form"]',
  credentialFormName: '[data-testid="credential-form-name"]',
  credentialFormUsername: '[data-testid="credential-form-username"]',
  credentialFormKindPassword: '[data-testid="credential-form-kind-password"]',
  credentialFormKindSshKey: '[data-testid="credential-form-kind-sshkey"]',
  credentialFormPassword: '[data-testid="credential-form-password"]',
  credentialFormPrivateKeyPath: '[data-testid="credential-form-private-key-path"]',
  credentialFormPrivateKey: '[data-testid="credential-form-private-key"]',
  credentialFormPassphrase: '[data-testid="credential-form-passphrase"]',
  credentialFormSubmit: '[data-testid="credential-form-submit"]',
  credentialFormCancel: '[data-testid="credential-form-cancel"]',
  // Edit mode fetches the credential's secrets on open; the form carries
  // `data-secrets-state` = none | loading | loaded | error.
  credentialFormSecretsState: (state: "none" | "loading" | "loaded" | "error") =>
    `[data-testid="credential-form"][data-secrets-state="${state}"]`,
  // Scoped under a credential row (see credentialRowByName).
  credentialRowEditButton: '[data-testid^="edit-credential-"]',
  credentialRowDeleteButton: '[data-testid^="delete-credential-"]',
  // Delete-credential confirm dialog; its error line shows a refusal.
  confirmDeleteCredential: '[data-testid="confirm-delete-credential"]',
  confirmDeleteCredentialConfirm: '[data-testid="confirm-delete-credential-confirm"]',
  confirmDeleteCredentialError: '[data-testid="confirm-delete-credential-error"]',

  // Connect / terminal
  connectButton: (id: string) => `[data-testid="connect-button-${id}"]`,
  editConnection: (id: string) => `[data-testid="edit-connection-${id}"]`,
  terminalContainer: '[data-testid="terminal-container"]',
  failedTerminal: '[data-testid="failed-terminal"]',
  trustHostKeyButton: '[data-testid="trust-host-key-button"]',
  terminalTabClose: (id: string) => `[data-testid="close-tab-${id}"]`,

  // SCP dialog
  scpOpenButton: (connectionId: string) => `[data-testid="scp-open-${connectionId}"]`,
  scpDialog: '[data-testid="scp-dialog"]',
  scpModeUpload: '[data-testid="scp-mode-upload"]',
  scpModeDownload: '[data-testid="scp-mode-download"]',
  scpLocalPath: '[data-testid="scp-local-path"]',
  scpRemotePath: '[data-testid="scp-remote-path"]',
  scpUploadButton: '[data-testid="scp-upload"]',
  scpDownloadButton: '[data-testid="scp-download"]',
  scpStatus: '[data-testid="scp-status"]',

  // Port forwards
  // "Start" a forward = clicking Connect on its local forward connection
  // row, so the button is the same as the generic connect button.
  forwardRowByName: (name: string) =>
    `[data-testid^="forward-row-"][data-name="${name}"]`,
  forwardStartButton: (id: string) => `[data-testid="connect-button-${id}"]`,
  forwardStopButton: (id: string) => `[data-testid="forward-stop-${id}"]`,
  forwardStatus: (id: string) => `[data-testid="forward-status-${id}"]`,

  // Git sync
  gitSyncRepoPath: '[data-testid="git-sync-repo-path"]',
  gitSyncExportButton: '[data-testid="git-sync-export"]',
  gitSyncStatus: '[data-testid="git-sync-status"]',

  // Generate / install key dialogs
  generateKeyOpen: '[data-testid="generate-key-open"]',
  generateKeyDialog: '[data-testid="generate-key-dialog"]',
  generateKeySubmit: '[data-testid="generate-key-submit"]',
  installKeyOpen: (credentialId: string) => `[data-testid="install-key-${credentialId}"]`,
  installKeyDialog: '[data-testid="install-key-dialog"]',
  installKeyHost: '[data-testid="install-key-host"]',
  installKeyPort: '[data-testid="install-key-port"]',
  installKeyUsername: '[data-testid="install-key-username"]',
  installKeyPassword: '[data-testid="install-key-password"]',
  installKeySubmit: '[data-testid="install-key-submit"]',
  installKeyClose: '[data-testid="install-key-close"]',

  // Settings panel
  settingsGitSyncRepoPath: '[data-testid="settings-git-sync-repo-path"]',
  settingsSavedStatus: '[data-testid="settings-saved-status"]',

  // Settings → Backups. Rows carry `data-name` (archive file name) and
  // `data-reason` (manual, automatic, before_restore), newest first.
  backupCreate: '[data-testid="backup-create"]',
  backupNotice: '[data-testid="backup-notice"]',
  backupRow: '[data-testid="backup-row"]',
  backupRowByReason: (reason: string) => `[data-testid="backup-row"][data-reason="${reason}"]`,
  // Scoped under a backup row.
  backupRestoreButton: '[data-testid="backup-restore"]',
  backupRestoreConfirm: '[data-testid="backup-restore-dialog-confirm"]',
  backupRestoreDialog: '[data-testid="backup-restore-dialog"]',

  // Scripts view. Script rows, host checkboxes and result cards carry
  // `data-name` (script or connection name); results also carry
  // `data-status` (running, success, error, cancelled) and `data-exit-code`.
  addScriptButton: '[data-testid="add-script-button"]',
  scriptForm: '[data-testid="script-form"]',
  scriptFormName: '[data-testid="script-form-name"]',
  scriptFormPlatformPosix: '[data-testid="script-form-platform-posix"]',
  scriptFormPlatformWindows: '[data-testid="script-form-platform-windows"]',
  scriptFormInterpreter: '[data-testid="script-form-interpreter"]',
  scriptFormBody: '[data-testid="script-form-body"]',
  scriptFormSubmit: '[data-testid="script-form-submit"]',
  scriptFormCancel: '[data-testid="script-form-cancel"]',
  scriptRowByName: (name: string) => `[data-testid="script-row"][data-name="${name}"]`,
  // Scoped under a script row.
  scriptRowSelect: '[data-testid="script-row-select"]',
  scriptHostByName: (name: string) => `[data-testid="script-host"][data-name="${name}"]`,
  // The selected script's platform badge.
  scriptPlatform: '[data-testid="script-platform"]',
  scriptRun: '[data-testid="script-run"]',
  scriptCancel: '[data-testid="script-cancel"]',
  scriptResultByName: (name: string) => `[data-testid="script-result"][data-name="${name}"]`,
  // Scoped under a result card.
  scriptResultStdout: '[data-testid="script-result-stdout"]',
  scriptResultStderr: '[data-testid="script-result-stderr"]',

  // Layout toggle (list / tile / tags)
  layoutToggleList: '[data-testid="layout-toggle-list"]',
  layoutToggleTile: '[data-testid="layout-toggle-tile"]',
  layoutToggleTags: '[data-testid="layout-toggle-tags"]',

  // Tag-group view. Tile testids encode the tag label as a URL-safe
  // slug (lowercase, non-alphanumeric chars collapsed to "-") so that
  // CSS-special characters in user-entered tag names never break
  // attribute selectors. "untagged" is the sentinel for the
  // no-tag group.
  tagGroupGrid: '[data-testid="tag-group-grid"]',
  tagGroup: (label: string) =>
    `[data-testid="tag-group-${slugifyTagId(label)}"]`,
  tagConnectAll: (label: string) =>
    `[data-testid="tag-connect-all-${slugifyTagId(label)}"]`,
  tagScpAll: (label: string) =>
    `[data-testid="tag-scp-all-${slugifyTagId(label)}"]`,

  // Bulk SCP dialog
  bulkScpDialog: '[data-testid="bulk-scp-dialog"]',
  bulkScpModeUpload: '[data-testid="bulk-scp-mode-upload"]',
  bulkScpModeDownload: '[data-testid="bulk-scp-mode-download"]',
  bulkScpLocalPath: '[data-testid="bulk-scp-local-path"]',
  bulkScpRemotePath: '[data-testid="bulk-scp-remote-path"]',
  bulkScpStart: '[data-testid="bulk-scp-start"]',
  bulkScpProgress: '[data-testid="bulk-scp-progress"]',
  bulkScpRow: (connectionId: string) =>
    `[data-testid="bulk-scp-row-${connectionId}"]`,
  bulkScpSummary: '[data-testid="bulk-scp-summary"]',

  // Tag-action confirm dialog (Connect-all / SCP-all gate)
  confirmTagAction: '[data-testid="confirm-tag-action"]',
  confirmTagActionConfirm: '[data-testid="confirm-tag-action-confirm"]',
  confirmTagActionCancel: '[data-testid="confirm-tag-action-cancel"]',

  // Load-error banners (shown instead of an empty list when a load fails)
  connectionsLoadError: '[data-testid="connections-load-error"]',
  connectionsLoadErrorRetry: '[data-testid="connections-load-error-retry"]',
  credentialsLoadError: '[data-testid="credentials-load-error"]',
  credentialsLoadErrorRetry: '[data-testid="credentials-load-error-retry"]',
  settingsLoadError: '[data-testid="settings-load-error"]',
  settingsLoadErrorRetry: '[data-testid="settings-load-error-retry"]',
  scriptsLoadError: '[data-testid="scripts-load-error"]',
} as const;
