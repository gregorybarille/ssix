/**
 * Single source of truth for `data-testid` selectors used by E2E specs.
 *
 * The corresponding attributes are added to React components in the
 * "data-testid additions" patch. Keeping them centralised here means
 * a refactor that renames a testid only requires editing this file.
 */

export const sel = {
  // Top-level navigation
  sidebar: '[data-testid="sidebar"]',
  navConnections: '[data-testid="nav-connections"]',
  navCredentials: '[data-testid="nav-credentials"]',
  navTunnels: '[data-testid="nav-tunnels"]',
  navSettings: '[data-testid="nav-settings"]',
  navGitSync: '[data-testid="nav-git-sync"]',
  navLogs: '[data-testid="nav-logs"]',

  // Connection list (renders as either `connection-grid` or
  // `connection-list-rows`; specs use the row testid pattern).
  connectionList: '[data-testid="connection-grid"], [data-testid="connection-list-rows"]',
  connectionRow: (id: string) => `[data-testid="connection-row-${id}"]`,
  connectionRowByName: (name: string) =>
    `[data-testid^="connection-row-"][data-name="${name}"]`,
  addConnectionButton: '[data-testid="add-connection-button"]',

  // Connection form
  connectionForm: '[data-testid="connection-form"]',
  connectionFormName: '[data-testid="connection-form-name"]',
  connectionFormHost: '[data-testid="connection-form-host"]',
  connectionFormPort: '[data-testid="connection-form-port"]',
  connectionFormCredential: '[data-testid="connection-form-credential"]',
  connectionFormKindDirect: '[data-testid="connection-form-kind-direct"]',
  connectionFormKindJumpShell: '[data-testid="connection-form-kind-jumpshell"]',
  connectionFormKindPortForward: '[data-testid="connection-form-kind-portforward"]',
  connectionFormGateway: '[data-testid="connection-form-gateway"]',
  connectionFormGatewayPort: '[data-testid="connection-form-gateway-port"]',
  connectionFormGatewayCredential: '[data-testid="connection-form-gateway-credential"]',
  connectionFormDestHost: '[data-testid="connection-form-dest-host"]',
  connectionFormDestPort: '[data-testid="connection-form-dest-port"]',
  // The auth-section credential picker. In Direct mode it's *the*
  // credential. In JumpShell mode it represents the destination
  // credential (the gateway has its own picker, see GatewayCredential).
  connectionFormDestCredential: '[data-testid="connection-form-credential"]',
  connectionFormLocalPort: '[data-testid="connection-form-local-port"]',
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
  credentialFormSubmit: '[data-testid="credential-form-submit"]',

  // Connect / terminal
  connectButton: (id: string) => `[data-testid="connect-button-${id}"]`,
  terminalContainer: '[data-testid="terminal-container"]',
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

  // Tunnels
  // "Start" a tunnel = clicking Connect on its port-forward connection
  // row, so the button is the same as the generic connect button.
  tunnelStartButton: (id: string) => `[data-testid="connect-button-${id}"]`,
  tunnelStopButton: (id: string) => `[data-testid="tunnel-stop-${id}"]`,
  tunnelStatus: (id: string) => `[data-testid="tunnel-status-${id}"]`,

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
  settingsSave: '[data-testid="settings-save"]',
  settingsGitSyncRepoPath: '[data-testid="settings-git-sync-repo-path"]',
} as const;
