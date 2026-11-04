import { useEffect } from "react";
import { create } from "zustand";
import type { Connection, Credential, OpenMode } from "@/types";
import { useTerminalsStore } from "./useTerminalsStore";

export interface ScreenshotToast {
  kind: "success" | "error";
  message: string;
}

export type ClosePaneTarget =
  | { kind: "pane"; sessionId: string; name: string }
  | { kind: "tab"; tabId: string; name: string };

const sameTarget = (a: ClosePaneTarget, b: ClosePaneTarget) =>
  a.kind === "pane"
    ? b.kind === "pane" && a.sessionId === b.sessionId
    : b.kind === "tab" && a.tabId === b.tabId;

const stillOpen = (target: ClosePaneTarget) =>
  useTerminalsStore
    .getState()
    .tabs.some((tab) =>
      target.kind === "tab"
        ? tab.id === target.tabId
        : tab.panes.some((pane) => pane.sessionId === target.sessionId),
    );

/**
 * Audit-4 Phase 5d: every dialog in App.tsx (connection form,
 * credential form, clone form, ConnectPicker, ScpDialog, the three
 * confirm dialogs, the orphan-credential dialog, the context menu
 * and the screenshot toast) used to be a separate `useState`
 * hook on the App component. Co-locating them in a single store
 * lets terminal/port forward actions reach across — e.g. "Edit from a
 * failed terminal pane" can flip view to connections AND open
 * the form in one call without prop-drilling setters.
 *
 * This store deliberately holds only UI-presentation state: no
 * IPC, no persistence, no async work. Submit handlers still live
 * in App.tsx where they can compose connection + credential +
 * port forward stores together.
 */
/**
 * Called before an open editor is swapped for another one; runs `proceed`
 * at once when the form is clean, or after the user agrees to discard.
 */
export type FormSwitchGuard = (proceed: () => void) => void;

interface DialogsState {
  // Connection form
  connFormOpen: boolean;
  /**
   * Registered by the open connection form. The list stays visible beside
   * the form panel, so "Edit" on another row must not silently replace
   * unsaved changes.
   */
  connFormGuard: FormSwitchGuard | null;
  credFormGuard: FormSwitchGuard | null;
  setConnFormGuard: (guard: FormSwitchGuard | null) => void;
  setCredFormGuard: (guard: FormSwitchGuard | null) => void;
  editingConn: Connection | null;
  cloningConn: Connection | null;

  // Credential form
  credFormOpen: boolean;
  editingCred: Credential | null;

  // Connect picker (Cmd+K, "+ tab")
  pickerOpen: boolean;
  pickerMode: OpenMode;

  // Screenshot saved/failed toast
  screenshotToast: ScreenshotToast | null;

  // SCP file-transfer dialog
  scpConnection: Connection | null;
  scpOpen: boolean;
  /** A transfer is running: its dialog keeps its target, so its outcome is shown. */
  scpBusy: boolean;
  setScpBusy: (busy: boolean) => void;

  // Bulk SCP dialog (operates on a tag group's connection set).
  // We deliberately store the connection list verbatim rather than
  // a tag key — the tags view computes the membership at click
  // time, and the dialog should freeze that snapshot for the
  // duration of the transfer (tags edited mid-batch shouldn't
  // change which hosts get hit).
  bulkScpOpen: boolean;
  bulkScpConnections: Connection[];
  bulkScpLabel: string;

  // Confirmation dialogs
  confirmDeleteConn: Connection | null;
  confirmDeleteCred: Credential | null;
  // What "Close terminal?" will close on confirm: one pane, or every
  // pane of a split tab. `name` is the human label shown in the prompt.
  /** The question on screen. Both panes of a split can end at once: the rest wait here. */
  confirmClosePane: ClosePaneTarget | null;
  closePaneQueue: ClosePaneTarget[];
  /** Counts the questions that took over from an answered one. */
  closePaneTurn: number;
  // Tag-group bulk action confirmation. We always confirm before
  // running Connect-all or SCP-all on a tag group regardless of
  // host count — these actions can spawn dozens of SSH sessions
  // or transfer files to many hosts in one click, so a misclick
  // is genuinely costly. The payload carries the action kind plus
  // the connection snapshot, and the App resolves it on confirm.
  confirmTagAction: {
    kind: "connect" | "scp";
    label: string;
    connections: Connection[];
  } | null;

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

  setScreenshotToast: (toast: ScreenshotToast | null) => void;

  openScp: (conn: Connection) => void;
  setScpOpen: (open: boolean) => void;

  openBulkScp: (label: string, connections: Connection[]) => void;
  setBulkScpOpen: (open: boolean) => void;

  setConfirmDeleteConn: (conn: Connection | null) => void;
  setConfirmDeleteCred: (cred: Credential | null) => void;
  /** Ask about closing this, once, and after any question already waiting. */
  askClosePane: (target: ClosePaneTarget) => void;
  /** The question on screen is settled: on to the next one about something still open. */
  closePaneAnswered: () => void;
  setConfirmTagAction: (
    payload:
      | { kind: "connect" | "scp"; label: string; connections: Connection[] }
      | null,
  ) => void;
}

/** Run `proceed` through the open form's guard, if a form is open. */
function guarded(open: boolean, guard: FormSwitchGuard | null, proceed: () => void) {
  if (open && guard) guard(proceed);
  else proceed();
}

export const useDialogsStore = create<DialogsState>((set, get) => ({
  connFormGuard: null,
  credFormGuard: null,
  setConnFormGuard: (guard) => set({ connFormGuard: guard }),
  setCredFormGuard: (guard) => set({ credFormGuard: guard }),
  connFormOpen: false,
  editingConn: null,
  cloningConn: null,
  credFormOpen: false,
  editingCred: null,
  pickerOpen: false,
  pickerMode: "tab",
  screenshotToast: null,
  scpConnection: null,
  scpOpen: false,
  scpBusy: false,
  setScpBusy: (scpBusy) => set({ scpBusy }),
  bulkScpOpen: false,
  bulkScpConnections: [],
  bulkScpLabel: "",
  confirmDeleteConn: null,
  confirmDeleteCred: null,
  confirmClosePane: null,
  closePaneQueue: [],
  closePaneTurn: 0,
  confirmTagAction: null,

  openNewConnection: () =>
    guarded(get().connFormOpen, get().connFormGuard, () =>
      set({ editingConn: null, cloningConn: null, connFormOpen: true }),
    ),
  openEditConnection: (conn) =>
    guarded(get().connFormOpen, get().connFormGuard, () =>
      set({ editingConn: conn, cloningConn: null, connFormOpen: true }),
    ),
  openCloneConnection: (conn) =>
    guarded(get().connFormOpen, get().connFormGuard, () =>
      set({ cloningConn: conn, editingConn: null, connFormOpen: true }),
    ),
  setConnFormOpen: (open) =>
    set(
      open
        ? { connFormOpen: true }
        : { connFormOpen: false, editingConn: null, cloningConn: null },
    ),

  openNewCredential: () =>
    guarded(get().credFormOpen, get().credFormGuard, () =>
      set({ editingCred: null, credFormOpen: true }),
    ),
  openEditCredential: (cred) =>
    guarded(get().credFormOpen, get().credFormGuard, () =>
      set({ editingCred: cred, credFormOpen: true }),
    ),
  setCredFormOpen: (open) =>
    set(open ? { credFormOpen: true } : { credFormOpen: false, editingCred: null }),

  openPicker: (mode = "tab") => set({ pickerMode: mode, pickerOpen: true }),
  setPickerOpen: (open) => set({ pickerOpen: open }),

  setScreenshotToast: (toast) => set({ screenshotToast: toast }),

  openScp: (conn) => set((s) => (s.scpBusy ? s : { scpConnection: conn, scpOpen: true })),
  setScpOpen: (open) => set({ scpOpen: open }),

  openBulkScp: (label, connections) =>
    set((s) =>
      s.scpBusy
        ? s
        : {
            bulkScpOpen: true,
            bulkScpLabel: label,
            bulkScpConnections: connections,
          },
    ),
  setBulkScpOpen: (open) =>
    set(
      open
        ? { bulkScpOpen: true }
        : { bulkScpOpen: false, bulkScpConnections: [], bulkScpLabel: "" },
    ),

  setConfirmDeleteConn: (conn) => set({ confirmDeleteConn: conn }),
  setConfirmDeleteCred: (cred) => set({ confirmDeleteCred: cred }),
  askClosePane: (target) =>
    set((state) => {
      if (!state.confirmClosePane) return { confirmClosePane: target };
      const asked = [state.confirmClosePane, ...state.closePaneQueue];
      if (asked.some((other) => sameTarget(other, target))) return state;
      return { closePaneQueue: [...state.closePaneQueue, target] };
    }),
  closePaneAnswered: () =>
    set((state) => {
      const [next, ...rest] = state.closePaneQueue.filter(stillOpen);
      return {
        confirmClosePane: next ?? null,
        closePaneQueue: rest,
        closePaneTurn: state.closePaneTurn + (next ? 1 : 0),
      };
    }),
  setConfirmTagAction: (payload) => set({ confirmTagAction: payload }),
}));

/** Hold the SCP dialogs on their target for as long as `busy` is true. */
export function useHoldScpTarget(busy: boolean) {
  const setScpBusy = useDialogsStore((s) => s.setScpBusy);
  useEffect(() => {
    if (!busy) return;
    setScpBusy(true);
    return () => setScpBusy(false);
  }, [busy, setScpBusy]);
}
