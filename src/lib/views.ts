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
import { Braces } from "lucide-react";

/**
 * Where a view's button starts. `main` is the sidebar's top group, for what is
 * used every day, and `footer` its bottom group, for what is used now and then:
 * the user can reorder these and move a button between them (see
 * `sidebarOrder.ts`). `sessions` shows between them only while terminals are
 * open and stays put, and `titlebar` has no sidebar button.
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
 * and the `NavItem` type all follow. Within a placement, this is the default
 * order; a user with an order of their own gets a new view at the end of its group.
 */
const VIEW_TABLE = [
  {
    id: "connections",
    label: "Connections",
    description: "Your saved hosts: open a terminal, transfer files",
    icon: Server,
    placement: "main",
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
    id: "snippets",
    label: "Snippets",
    description: "Saved commands to paste into a terminal",
    icon: Braces,
    placement: "main",
    component: lazy(() =>
      import("@/components/views/SnippetsView").then((m) => ({ default: m.SnippetsView })),
    ),
  },
  {
    id: "forwards",
    label: "Port forwards",
    description: "Port forwards (ssh -L, -R, -D) and whether they are running",
    icon: Cable,
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
    id: "credentials",
    label: "Credentials",
    description: "Passwords and SSH keys used to log in",
    icon: Key,
    placement: "footer",
  },
  {
    id: "logs",
    label: "Logs",
    description: "What the app and your connections did",
    icon: ScrollText,
    placement: "footer",
    component: lazy(() => import("@/components/LogsView").then((m) => ({ default: m.LogsView }))),
  },
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
