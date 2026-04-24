import { create } from "zustand";
import type { Connection, Credential, OpenMode } from "@/types";

/**
 * Audit-4 Phase 5d: every dialog in App.tsx (connection form,
 * credential form, clone form, ConnectPicker, ScpDialog, the three
 * confirm dialogs, the orphan-credential dialog, the context menu
 * and the screenshot toast) used to be a separate `useState`
 * hook on the App component. Co-locating them in a single store
 * lets terminal/tunnel actions reach across — e.g. "Edit from a
 * failed terminal pane" can flip view to connections AND open
 * the form in one call without prop-drilling setters.
 *
 * This store deliberately holds only UI-presentation state: no
 * IPC, no persistence, no async work. Submit handlers still live
 * in App.tsx where they can compose connection + credential +
 * tunnel stores together.
 */
interface DialogsState {
  // Connection form
  connFormOpen: boolean;
  editingConn: Connection | null;
  cloningConn: Connection | null;

  // Credential form
  credFormOpen: boolean;
  editingCred: Credential | null;

  // Connect picker (Cmd+K, "+ tab")
  pickerOpen: boolean;
  pickerMode: OpenMode;

  // Right-click context menu
  contextMenu: { x: number; y: number } | null;

  // Screenshot saved/failed toast
  screenshotToast: string | null;

  // SCP file-transfer dialog
  scpConnection: Connection | null;
  scpOpen: boolean;

  // Orphaned-private-credential prompt when deleting a connection
  orphanCredDialog: { connId: string; credId: string } | null;

  // Confirmation dialogs
  confirmDeleteConn: Connection | null;
  confirmDeleteCred: Credential | null;
  confirmClosePane: { sessionId: string; name: string } | null;

  // Mutators
  openNewConnection: () => void;
  openEditConnection: (conn: Connection) => void;
  openCloneConnection: (conn: Connection) => void;
  setConnFormOpen: (open: boolean) => void;

  openNewCredential: () => void;
  openEditCredential: (cred: Credential) => void;
  setCredFormOpen: (open: boolean) => void;

  openPicker: (mode?: OpenMode) => void;
  setPickerOpen: (open: boolean) => void;

  setContextMenu: (pos: { x: number; y: number } | null) => void;
  setScreenshotToast: (msg: string | null) => void;

  openScp: (conn: Connection) => void;
  setScpOpen: (open: boolean) => void;

  setOrphanCredDialog: (
    payload: { connId: string; credId: string } | null,
  ) => void;
  setConfirmDeleteConn: (conn: Connection | null) => void;
  setConfirmDeleteCred: (cred: Credential | null) => void;
  setConfirmClosePane: (
    payload: { sessionId: string; name: string } | null,
  ) => void;
}

export const useDialogsStore = create<DialogsState>((set) => ({
  connFormOpen: false,
  editingConn: null,
  cloningConn: null,
  credFormOpen: false,
  editingCred: null,
  pickerOpen: false,
  pickerMode: "tab",
  contextMenu: null,
  screenshotToast: null,
  scpConnection: null,
  scpOpen: false,
  orphanCredDialog: null,
  confirmDeleteConn: null,
  confirmDeleteCred: null,
  confirmClosePane: null,

  openNewConnection: () =>
    set({ editingConn: null, cloningConn: null, connFormOpen: true }),
  openEditConnection: (conn) =>
    set({ editingConn: conn, cloningConn: null, connFormOpen: true }),
  openCloneConnection: (conn) =>
    set({ cloningConn: conn, editingConn: null, connFormOpen: true }),
  setConnFormOpen: (open) =>
    set(
      open
        ? { connFormOpen: true }
        : { connFormOpen: false, editingConn: null, cloningConn: null },
    ),

  openNewCredential: () => set({ editingCred: null, credFormOpen: true }),
  openEditCredential: (cred) =>
    set({ editingCred: cred, credFormOpen: true }),
  setCredFormOpen: (open) =>
    set(open ? { credFormOpen: true } : { credFormOpen: false, editingCred: null }),

  openPicker: (mode = "tab") => set({ pickerMode: mode, pickerOpen: true }),
  setPickerOpen: (open) => set({ pickerOpen: open }),

  setContextMenu: (pos) => set({ contextMenu: pos }),
  setScreenshotToast: (msg) => set({ screenshotToast: msg }),

  openScp: (conn) => set({ scpConnection: conn, scpOpen: true }),
  setScpOpen: (open) => set({ scpOpen: open }),

  setOrphanCredDialog: (payload) => set({ orphanCredDialog: payload }),
  setConfirmDeleteConn: (conn) => set({ confirmDeleteConn: conn }),
  setConfirmDeleteCred: (cred) => set({ confirmDeleteCred: cred }),
  setConfirmClosePane: (payload) => set({ confirmClosePane: payload }),
}));
