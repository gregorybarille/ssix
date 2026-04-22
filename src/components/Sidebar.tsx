import React from "react";
import { Server, Key, TerminalSquare, Cable, ScrollText } from "lucide-react";
import { cn } from "@/lib/utils";

export type NavItem =
  | "connections"
  | "credentials"
  | "tunnels"
  | "logs"
  | "settings"
  | "terminals";

interface SidebarProps {
  active: NavItem;
  onNavigate: (item: NavItem) => void;
  terminalCount?: number;
  tunnelCount?: number;
}

const navItems: { id: NavItem; label: string; icon: React.ReactNode }[] = [
  { id: "connections", label: "Connections", icon: <Server className="h-5 w-5" /> },
  { id: "credentials", label: "Credentials", icon: <Key className="h-5 w-5" /> },
  { id: "tunnels", label: "Tunnels", icon: <Cable className="h-5 w-5" /> },
  { id: "logs", label: "Logs", icon: <ScrollText className="h-5 w-5" /> },
];

function NavButton({
  active,
  label,
  onClick,
  icon,
  badge,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  badge?: number;
}) {
  return (
    <button
      title={badge ? `${label} (${badge})` : label}
      onClick={onClick}
      className={cn(
        "w-10 h-10 rounded-lg flex items-center justify-center transition-colors relative",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
      )}
    >
      {icon}
      {badge !== undefined && badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center px-1">
          {badge}
        </span>
      )}
    </button>
  );
}

export function Sidebar({
  active,
  onNavigate,
  terminalCount = 0,
  tunnelCount = 0,
}: SidebarProps) {
  return (
    <aside className="w-16 bg-card border-r border-border flex flex-col items-center py-4 gap-2">
      <div className="mb-4">
        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
          <span className="text-primary-foreground font-bold text-sm">S</span>
        </div>
      </div>
      {navItems.map(({ id, label, icon }) => (
        <NavButton
          key={id}
          active={active === id}
          label={label}
          onClick={() => onNavigate(id)}
          icon={icon}
          badge={id === "tunnels" ? tunnelCount : undefined}
        />
      ))}

      {terminalCount > 0 && (
        <>
          <div className="w-6 border-t border-border my-1" />
          <NavButton
            active={active === "terminals"}
            label="Terminals"
            onClick={() => onNavigate("terminals")}
            icon={<TerminalSquare className="h-5 w-5" />}
            badge={terminalCount}
          />
        </>
      )}
    </aside>
  );
}
