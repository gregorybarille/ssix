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
  // The sidebar's two reorderable groups, and what a drag of one of their buttons shows.
  sidebarGroup: (group: "top" | "bottom") => `[data-testid="sidebar-${group}"]`,
  sidebarDragChip: '[data-testid="sidebar-drag-chip"]',
  sidebarMenuItem: (name: string) => `//*[@role="menuitem"][normalize-space()="${name}"]`,
  contextMenu: '[role="menu"]',
  screenshotToast: '[data-testid="screenshot-toast"]',
  // Each sidebar button's tooltip is `${its testid}-tooltip`.
  navTooltip: (navTestId: string) => `[data-testid="${navTestId}-tooltip"]`,

  // The right-hand column every editor and SCP panel opens in.
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
  connectionRowDeleteButton: '[data-testid^="delete-connection-"]',
  connectionSearchInput: '[data-testid="connection-search-input"]',
  connectionsNoMatch: '[data-testid="connections-no-match"]',
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
  // The Type dropdown, and the names of its options for `pickOption`.
  connectionFormType: '[data-testid="connection-form-type"]',
  connectionFormKindDirect: 'Direct',
  connectionFormKindJumpHost: 'Jump host (-J)',
  connectionFormKindLocalForward: 'Local forward (-L)',
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
  connectionFormBindAddress: '[data-testid="connection-form-bind-address"]',
  connectionFormBindWarning: '[data-testid="connection-form-bind-warning"]',
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
  scpStop: '[data-testid="scp-stop"]',
  scpStatus: '[data-testid="scp-status"]',
  scpError: '[data-testid="scp-error"]',

  // Port forwards
  // "Start" a forward = clicking Connect on its forward connection
  // row, so the button is the same as the generic connect button.
  forwardRowByName: (name: string) =>
    `[data-testid^="forward-row-"][data-name="${name}"]`,
  forwardStartButton: (id: string) => `[data-testid="connect-button-${id}"]`,
  forwardStopButton: (id: string) => `[data-testid="forward-stop-${id}"]`,
  forwardStatus: (id: string) => `[data-testid="forward-status-${id}"]`,

  // Git sync
  gitSyncRepoPath: '[data-testid="git-sync-repo-path"]',
  gitSyncExportButton: '[data-testid="git-sync-export"]',
  gitSyncRunButton: '[data-testid="git-sync-run"]',
  gitSyncRefreshDiff: '[data-testid="git-sync-refresh-diff"]',
  gitSyncHandEdits: '[data-testid="git-sync-hand-edits"]',
  gitSyncStatus: '[data-testid="git-sync-status"]',
  gitSyncDiscard: '[data-testid="git-sync-discard"]',
  gitSyncDiscardConfirm: '[data-testid="git-sync-discard-confirm"]',
  gitSyncDiscardCancel: '[data-testid="git-sync-discard-cancel"]',

  // Generate / install key dialogs
  generateKeyOpen: '[data-testid="generate-key-open"]',
  generateKeyDialog: '[data-testid="generate-key-dialog"]',
  generateKeyPassphrase: '[data-testid="generate-key-passphrase"]',
  generateKeyStorageCustom: '[data-testid="generate-key-storage-custom"]',
  generateKeyCustomPath: '[data-testid="generate-key-custom-path"]',
  generateKeyError: '[data-testid="generate-key-error"]',
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
  settingsPanel: '[data-testid="settings-panel"]',
  settingsGitSyncRepoPath: '[data-testid="settings-git-sync-repo-path"]',
  settingsSavedStatus: '[data-testid="settings-saved-status"]',

  // The logo and name in the title bar.
  titleBarBrand: '[data-testid="title-bar-brand"]',

  // Settings → About. License rows carry `data-name`.
  settingsAbout: '[data-testid="settings-about"]',
  aboutVersion: '[data-testid="about-version"]',
  aboutAuthor: '[data-testid="about-author"]',
  aboutRepositoryLink: '[data-testid="about-repository-link"]',
  aboutLicenseLink: '[data-testid="about-license-link"]',
  aboutLicensesToggle: '[data-testid="about-licenses-toggle"]',
  aboutLicensesFilter: '[data-testid="about-licenses-filter"]',
  aboutLicenseRow: '[data-testid="about-license-row"]',
  aboutLicenseRowByName: (name: string) =>
    `[data-testid="about-license-row"][data-name=${JSON.stringify(name)}]`,

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
  // "Discard unsaved changes?" for the script editor.
  scriptDiscard: '[data-testid="script-discard"]',
  scriptDiscardConfirm: '[data-testid="script-discard-confirm"]',
  scriptDiscardCancel: '[data-testid="script-discard-cancel"]',
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
  bulkScpStop: '[data-testid="bulk-scp-stop"]',
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

  // Each roadmap stream appends its selectors under its own anchor.
  // roadmap:auth
  credentialFormKindAgent: '[data-testid="credential-form-kind-agent"]',
  credentialFormAgentHint: '[data-testid="credential-form-agent-hint"]',
  connectionFormAgentForwarding: '[data-testid="connection-form-agent-forwarding"]',
  // Scoped under a connection row (see connectionRowByName).
  connectionRowEditButton: '[data-testid^="edit-connection-"]',
  authPrompt: '[data-testid="auth-prompt"]',
  authPromptInput: (index: number) => `[data-testid="auth-prompt-input-${index}"]`,
  authPromptSubmit: '[data-testid="auth-prompt-submit"]',
  authPromptCancel: '[data-testid="auth-prompt-cancel"]',
  authPromptReconnecting: '[data-testid="auth-prompt-reconnecting"]',
  authPromptRefused: '[data-testid="auth-prompt-refused"]',
  navTerminalsWaiting: '[data-testid="nav-terminals-waiting"]',
  terminalTabPromptWaiting: '[data-testid="terminal-tab-prompt-waiting"]',
  terminalNewMenu: '[data-testid="terminal-new-menu"]',
  terminalNewSplitRight: '[data-testid="terminal-new-split-right"]',
  terminalNewSplitDown: '[data-testid="terminal-new-split-down"]',
  terminalSplitSeparator: '[data-testid="terminal-split-separator"]',
  connectPickerInput: '[data-testid="connect-picker-input"]',
  // roadmap:resilience
  // The status view of a shell that lost its connection (phase: waiting | stopped).
  reconnectStatus: '[data-testid="failed-terminal"][data-reconnect-phase]',
  reconnectStatusPhase: (phase: "waiting" | "stopped") =>
    `[data-testid="failed-terminal"][data-reconnect-phase="${phase}"]`,
  reconnectCancelButton: '[data-testid="reconnect-cancel-button"]',
  failedTerminalRetry: '[data-testid="failed-terminal-retry"]',
  failedTerminalDismiss: '[data-testid="failed-terminal-dismiss"]',
  failedTerminalEdit: '[data-testid="failed-terminal-edit"]',
  connectionFormKeepalive: '[data-testid="connection-form-keepalive"]',
  connectionFormAutoReconnect: '[data-testid="connection-form-auto-reconnect"]',
  connectionFormLogSession: '[data-testid="connection-form-log-session"]',
  settingsKeepaliveInterval: '[data-testid="settings-keepalive-interval"]',
  settingsAutoReconnect: '[data-testid="settings-auto-reconnect"]',
  settingsReconnectMaxAttempts: '[data-testid="settings-reconnect-max-attempts"]',
  settingsSessionLogEnabled: '[data-testid="settings-session-log-enabled"]',
  settingsSessionLogDir: '[data-testid="settings-session-log-dir"]',
  navTerminals: '[data-testid="nav-terminals"]',
  // Whichever terminal tab comes first; its id is generated.
  terminalTabCloseAny: '[data-testid^="close-tab-"]',
  confirmClosePane: '[data-testid="confirm-close-pane"]',
  confirmClosePaneConfirm: '[data-testid="confirm-close-pane-confirm"]',
  confirmClosePaneCancel: '[data-testid="confirm-close-pane-cancel"]',
  // roadmap:forwards
  connectionFormKindRemoteForward: 'Remote forward (-R)',
  connectionFormKindDynamicForward: 'Dynamic forward (-D)',
  connectionFormRemotePort: '[data-testid="connection-form-remote-port"]',
  connectionFormSocksPort: '[data-testid="connection-form-socks-port"]',
  confirmStopForwardConfirm: '[data-testid="confirm-stop-forward-confirm"]',
  confirmDeleteConnectionConfirm: '[data-testid="confirm-delete-connection-confirm"]',
  // roadmap:sftp
  navFiles: '[data-testid="nav-files"]',
  browseFilesButton: '[data-testid^="browse-files-"]',
  filesConnectionSelect: '[data-testid="files-connection-select"]',
  filesStatus: '[data-testid="files-status"]',
  filesConnectError: '[data-testid="files-connect-error"]',
  filesTrustHostKey: '[data-testid="files-trust-host-key"]',
  filesDisconnect: '[data-testid="files-disconnect"]',
  filesPane: (side: "local" | "remote") => `[data-testid="files-pane-${side}"]`,
  filesPath: (side: "local" | "remote") => `[data-testid="files-path-${side}"]`,
  filesUp: (side: "local" | "remote") => `[data-testid="files-up-${side}"]`,
  filesRefresh: (side: "local" | "remote") => `[data-testid="files-refresh-${side}"]`,
  filesMkdir: (side: "local" | "remote") => `[data-testid="files-mkdir-${side}"]`,
  filesRename: (side: "local" | "remote") => `[data-testid="files-rename-${side}"]`,
  filesChmod: (side: "local" | "remote") => `[data-testid="files-chmod-${side}"]`,
  filesDelete: (side: "local" | "remote") => `[data-testid="files-delete-${side}"]`,
  filesTransfer: (side: "local" | "remote") => `[data-testid="files-transfer-${side}"]`,
  fileRow: (side: "local" | "remote", name: string) =>
    `[data-testid="files-pane-${side}"] [data-testid="file-row"][data-name="${name}"]`,
  filesEdit: '[data-testid="files-edit"]',
  filesNameInput: '[data-testid="files-name-input"]',
  filesNameSubmit: '[data-testid="files-name-submit"]',
  filesChmodInput: '[data-testid="files-chmod-input"]',
  filesChmodSubmit: '[data-testid="files-chmod-submit"]',
  filesDeleteConfirm: '[data-testid="files-delete-confirm-confirm"]',
  filesDeleteCancel: '[data-testid="files-delete-confirm-cancel"]',
  filesDeleteError: '[data-testid="files-delete-confirm-error"]',
  filesOverwriteConfirm: '[data-testid="files-overwrite-confirm-confirm"]',
  filesOverwriteCancel: '[data-testid="files-overwrite-confirm-cancel"]',
  filesTransferRow: (name: string, status?: string) =>
    `[data-testid="files-transfer"][data-name="${name}"]${status ? `[data-status="${status}"]` : ""}`,
  filesTransferCancel: '[data-testid="files-transfer-cancel"]',
  filesEditPanel: '[data-testid="files-edit-panel"]',
  filesEditSave: '[data-testid="files-edit-save"]',
  filesEditClose: '[data-testid="files-edit-close"]',
  filesEditStatus: '[data-testid="files-edit-status"]',
  filesEditConflict: '[data-testid="files-edit-conflict"]',
  filesEditConflictConfirm: '[data-testid="files-edit-conflict-confirm"]',
  filesEditConflictCancel: '[data-testid="files-edit-conflict-cancel"]',
  filesEditDiscardCancel: '[data-testid="files-edit-discard-cancel"]',
  filesFooter: (side: "local" | "remote") => `[data-testid="files-footer-${side}"]`,
  // roadmap:snippets
  navSnippets: '[data-testid="nav-snippets"]',
  addSnippetButton: '[data-testid="add-snippet-button"]',
  snippetForm: '[data-testid="snippet-form"]',
  snippetFormName: '[data-testid="snippet-form-name"]',
  snippetFormCommand: '[data-testid="snippet-form-command"]',
  snippetFormTags: "#snippet-tags",
  snippetFormVariables: '[data-testid="snippet-form-variables"]',
  snippetFormGitSyncNotice: '[data-testid="snippet-form-git-sync-notice"]',
  snippetFormSubmit: '[data-testid="snippet-form-submit"]',
  snippetFormError: '[data-testid="snippet-form-error"]',
  snippetRowByName: (name: string) => `[data-testid="snippet-row"][data-name="${name}"]`,
  // Scoped under a snippet row.
  snippetRowEdit: '[data-testid="snippet-row-edit"]',
  snippetRowDelete: '[data-testid="snippet-row-delete"]',
  snippetDeleteConfirm: '[data-testid="snippet-delete-dialog-confirm"]',
  // The Snippets view's Paste button; Mod+Shift+S opens the same palette.
  snippetPaletteButton: '[data-testid="snippet-palette-button"]',
  snippetPalette: '[data-testid="snippet-palette"]',
  snippetPaletteTarget: '[data-testid="snippet-palette-target"]',
  snippetPaletteSearch: '[data-testid="snippet-palette-search"]',
  snippetPaletteError: '[data-testid="snippet-palette-error"]',
  snippetPaletteOptionByName: (name: string) =>
    `[data-testid="snippet-palette-option"][data-name="${name}"]`,
  snippetVariable: '[data-testid="snippet-variable"]',
  snippetVariableByName: (name: string) => `[data-testid="snippet-variable"][data-name="${name}"]`,
  snippetVariablesPreview: '[data-testid="snippet-variables-preview"]',
  snippetVariablesSubmit: '[data-testid="snippet-variables-submit"]',
  snippetDiscardCancel: '[data-testid="snippet-discard-cancel"]',
  snippetDiscardConfirm: '[data-testid="snippet-discard-confirm"]',
  terminalTabByName: (name: string) => `[role="tab"][aria-label^="Terminal ${name}"]`,
  terminalSplitRight: '//*[@role="menuitem"][contains(., "Split right")]',
  connectPickerOption: (name: string) => `[role="option"][data-name="${name}"]`,
  // roadmap:import
  importConfigButton: '[data-testid="import-config-button"]',
  importDialog: '[data-testid="import-dialog"]',
  importPath: '[data-testid="import-path"]',
  importLoad: '[data-testid="import-load"]',
  importFiles: '[data-testid="import-files"]',
  importConfirm: '[data-testid="import-confirm"]',
  importClose: '[data-testid="import-close"]',
  importResult: '[data-testid="import-result"]',
  importNothing: '[data-testid="import-nothing"]',
  importLoadError: '[data-testid="import-load-error"]',
  importSelectAll: '[data-testid="import-select-all"]',
  importNotice: '[data-testid="import-notice"]',
  importItems: '[data-testid="import-item"]',
  importItem: (name: string) => `[data-testid="import-item"][data-name="${name}"]`,
  // Scoped under an import item.
  importItemCheckbox: '[data-testid="import-item-checkbox"]',
  importSkip: (name: string) => `[data-testid="import-skip"][data-name="${name}"]`,
  // roadmap:terminal-ux
  terminalContainerBySession: (id: string) =>
    `[data-testid="terminal-container"][data-session-id="${id}"]`,
  terminalSearch: '[data-testid="terminal-search"]',
  terminalSearchInput: '[data-testid="terminal-search-input"]',
  terminalSearchStatus: '[data-testid="terminal-search-status"]',
  terminalSearchPrevious: '[data-testid="terminal-search-previous"]',
  terminalSearchNext: '[data-testid="terminal-search-next"]',
  terminalSearchClose: '[data-testid="terminal-search-close"]',
  terminalLinkHint: '[data-testid="terminal-link-hint"]',
  terminalLinkConfirm: '[data-testid="terminal-link-confirm"]',
  terminalLinkConfirmCancel: '[data-testid="terminal-link-confirm-cancel"]',
  terminalLinkConfirmHost: '[data-testid="terminal-link-confirm-host"]',
  terminalLinkConfirmUrl: '[data-testid="terminal-link-confirm-url"]',
  broadcastToggle: '[data-testid="broadcast-toggle"]',
  broadcastIndicator: '[data-testid="broadcast-indicator"]',
  broadcastSkipped: '[data-testid="broadcast-skipped"]',
  connectionFormFontFamily: '[data-testid="connection-form-font-family"]',
  connectionFormFontSize: '[data-testid="connection-form-font-size"]',
  connectionFormColorScheme: '[data-testid="connection-form-color-scheme"]',
  connectionFormColorSchemeError: '[data-testid="connection-form-color-scheme-error"]',
  // roadmap:folders
  layoutToggleFolders: '[data-testid="layout-toggle-folders"]',
  folderTree: '[data-testid="folder-tree"]',
  folderRow: (path: string) => `[data-testid="folder-row"][data-name="${path}"]`,
  folderNoFolder: '[data-testid="folder-no-folder"]',
  // Scoped under a folder row (see folderRow).
  folderCount: '[data-testid="folder-count"]',
  folderRename: '[data-testid="folder-rename"]',
  folderDelete: '[data-testid="folder-delete"]',
  // Scoped under a connection row (see connectionRowByName).
  connectionRowConnectButton: '[data-testid^="connect-button-"]',
  folderMoveMenuItem: '//*[@role="menuitem"][contains(., "Move to folder")]',
  folderRenameMenuItem: '//*[@role="menuitem"][contains(., "Rename folder")]',
  folderDragChip: '[data-testid="folder-drag-chip"]',
  folderMoveError: '[data-testid="folder-move-error"]',
  folderMoveDialog: '[data-testid="folder-move-dialog"]',
  folderMoveInput: '[data-testid="folder-move-input"]',
  folderMoveSubmit: '[data-testid="folder-move-submit"]',
  folderPickerToggle: '[data-testid="folder-picker-toggle"]',
  folderRenameDialog: '[data-testid="folder-rename-dialog"]',
  folderRenameInput: '[data-testid="folder-rename-input"]',
  folderRenameSubmit: '[data-testid="folder-rename-submit"]',
  folderRenameError: '[data-testid="folder-rename-error"]',
  folderRenamePreview: '[data-testid="folder-rename-preview"]',
  folderDeleteDialog: '[data-testid="folder-delete-dialog"]',
  folderDeleteContents: '[data-testid="folder-delete-contents"]',
  folderDeleteConfirm: '[data-testid="folder-delete-dialog-confirm"]',
  connectionFormFolder: '[data-testid="connection-form-folder"]',
  connectionFormFolderError: '[data-testid="connection-form-folder-error"]',
  folderPickerOption: (path: string) => `[data-testid="folder-picker-option"][data-name="${path}"]`,
} as const;
