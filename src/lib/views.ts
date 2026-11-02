import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import {
  Cable,
  FileCode,
  GitBranch,
  Key,
  ScrollText,
  Server,
  Settings,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";
// roadmap:sftp
import { FolderOpen } from "lucide-react";
// roadmap:snippets

/**
 * Where a view's button sits. `main` is the sidebar's list, `sessions` shows
 * below it only while terminals are open, `footer` is pinned to the bottom of
 * the sidebar, and `titlebar` has no sidebar button.
 */
export type ViewPlacement = "main" | "sessions" | "footer" | "titlebar";

export interface ViewDefinition<Id extends string = string> {
  id: Id;
  /** The button's accessible name and the first line of its tooltip. */
  label: string;
  /** The tooltip's second line: what the view is for. */
  description: string;
  icon: LucideIcon;
  placement: ViewPlacement;
  /**
   * The view itself, loaded on first use. `App.tsx` renders it with no props.
   * Leave it out only for a view `App.tsx` renders in its own branch because
   * it passes props.
   */
  component?: LazyExoticComponent<ComponentType>;
}

/**
 * Every view of the app. Add a view with one entry under your stream's
 * anchor: its sidebar button (test id `nav-<id>`, `_` becoming `-`), its route
 * and the `NavItem` type all follow. Within a placement, buttons keep this order.
 */
const VIEW_TABLE = [
  {
    id: "connections",
    label: "Connections",
    description: "Your saved hosts: open a terminal, transfer files",
    icon: Server,
    placement: "main",
  },
  {
    id: "forwards",
    label: "Port forwards",
    description: "Port forwards (ssh -L, -R, -D) and whether they are running",
    icon: Cable,
    placement: "main",
  },
  {
    id: "credentials",
    label: "Credentials",
    description: "Passwords and SSH keys used to log in",
    icon: Key,
    placement: "main",
  },
  {
    id: "scripts",
    label: "Scripts",
    description: "Saved scripts to run on several hosts at once",
    icon: FileCode,
    placement: "main",
    component: lazy(() =>
      import("@/components/views/ScriptsView").then((m) => ({ default: m.ScriptsView })),
    ),
  },
  {
    id: "logs",
    label: "Logs",
    description: "What the app and your connections did",
    icon: ScrollText,
    placement: "main",
    component: lazy(() => import("@/components/LogsView").then((m) => ({ default: m.LogsView }))),
  },
  // roadmap:sftp
  {
    id: "files",
    label: "Files",
    description: "Browse, copy and edit files on a connection",
    icon: FolderOpen,
    placement: "main",
    component: lazy(() =>
      import("@/components/views/FilesView").then((m) => ({ default: m.FilesView })),
    ),
  },
  // roadmap:snippets
  {
    id: "terminals",
    label: "Terminals",
    description: "The terminals you have open",
    icon: TerminalSquare,
    placement: "sessions",
  },
  {
    id: "git_sync",
    label: "Git Sync",
    description: "Export your connections and settings to a git repository",
    icon: GitBranch,
    placement: "footer",
    component: lazy(() =>
      import("@/components/GitSyncView").then((m) => ({ default: m.GitSyncView })),
    ),
  },
  {
    id: "settings",
    label: "Settings",
    description: "Appearance, terminal, git sync and backups",
    icon: Settings,
    placement: "titlebar",
  },
] as const satisfies readonly ViewDefinition[];

export type NavItem = (typeof VIEW_TABLE)[number]["id"];

export const VIEWS: readonly ViewDefinition<NavItem>[] = VIEW_TABLE;
