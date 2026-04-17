import React from "react";
import { Settings } from "lucide-react";
import { cn } from "@/lib/utils";

interface TitleBarProps {
  onSettings: () => void;
  settingsActive: boolean;
}

export function TitleBar({ onSettings, settingsActive }: TitleBarProps) {
  return (
    <div
      data-tauri-drag-region
      className="h-9 bg-card border-b border-border flex items-center select-none shrink-0"
    >
      {/* Left spacer for macOS traffic lights (~80px wide) */}
      <div className="w-20" data-tauri-drag-region />
      {/* Draggable fill area */}
      <div className="flex-1" data-tauri-drag-region />
      <button
        onClick={onSettings}
        title="Settings"
        className={cn(
          "mr-2 h-7 w-7 rounded-md flex items-center justify-center transition-colors",
          settingsActive
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
        )}
      >
        <Settings className="h-4 w-4" />
      </button>
    </div>
  );
}
