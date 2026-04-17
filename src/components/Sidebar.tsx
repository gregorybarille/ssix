import React from "react";
import { Server, Key, TerminalSquare } from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = "connections" | "credentials" | "settings" | "terminals";

interface SidebarProps {
  active: NavItem;
  onNavigate: (item: NavItem) => void;
  terminalCount?: number;
}

const navItems: { id: NavItem; label: string; icon: React.ReactNode }[] = [
  { id: "connections", label: "Connections", icon: <Server className="h-5 w-5" /> },
  { id: "credentials", label: "Credentials", icon: <Key className="h-5 w-5" /> },
];

export function Sidebar({ active, onNavigate, terminalCount = 0 }: SidebarProps) {
  return (
    <aside className="w-16 bg-card border-r border-border flex flex-col items-center py-4 gap-2">
      <div className="mb-4">
        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
          <span className="text-primary-foreground font-bold text-sm">S</span>
        </div>
      </div>
      {navItems.map(({ id, label, icon }) => (
        <button
          key={id}
          title={label}
          onClick={() => onNavigate(id)}
          className={cn(
            "w-10 h-10 rounded-lg flex items-center justify-center transition-colors",
            active === id
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
          )}
        >
          {icon}
        </button>
      ))}

      {terminalCount > 0 && (
        <>
          <div className="w-6 border-t border-border my-1" />
          <button
            title={`Terminals (${terminalCount})`}
            onClick={() => onNavigate("terminals")}
            className={cn(
              "w-10 h-10 rounded-lg flex items-center justify-center transition-colors relative",
              active === "terminals"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
            )}
          >
            <TerminalSquare className="h-5 w-5" />
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center px-1">
              {terminalCount}
            </span>
          </button>
        </>
      )}
    </aside>
  );
}
