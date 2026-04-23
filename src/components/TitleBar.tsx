import React, { useEffect, useState } from "react";
import { Settings, Minus, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Platform = "macos" | "windows" | "linux";

function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "macos";
  if (ua.includes("win")) return "windows";
  return "linux";
}

interface TitleBarProps {
  onSettings: () => void;
  settingsActive: boolean;
}

export function TitleBar({ onSettings, settingsActive }: TitleBarProps) {
  const [platform, setPlatform] = useState<Platform>("macos");
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  useEffect(() => {
    if (platform === "macos") return;
    let cancelled = false;
    const checkMaximized = async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const isMax = await getCurrentWindow().isMaximized();
        if (!cancelled) setMaximized(isMax);
      } catch {}
    };
    checkMaximized();
    return () => { cancelled = true; };
  }, [platform]);

  const windowAction = async (action: "minimize" | "toggleMaximize" | "close") => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      if (action === "minimize") await win.minimize();
      else if (action === "toggleMaximize") {
        await win.toggleMaximize();
        setMaximized(!maximized);
      } else await win.close();
    } catch {}
  };

  return (
    <div
      data-tauri-drag-region
      className="h-9 bg-card border-b border-border flex items-center select-none shrink-0"
    >
      {/* macOS: left spacer for traffic lights */}
      {platform === "macos" && <div className="w-20" data-tauri-drag-region />}

      {/* Draggable fill area */}
      <div className="flex-1" data-tauri-drag-region />

      <button
        onClick={onSettings}
        title="Settings"
        aria-label="Settings"
        aria-pressed={settingsActive}
        className={cn(
          "h-7 w-7 rounded-md flex items-center justify-center transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card",
          platform === "macos" ? "mr-2" : "mr-1",
          settingsActive
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
        )}
      >
        <Settings className="h-4 w-4" aria-hidden="true" />
      </button>

      {/* Windows/Linux: window control buttons */}
      {platform !== "macos" && (
        <div className="flex items-center h-full">
          <button
            onClick={() => windowAction("minimize")}
            className="h-full w-11 flex items-center justify-center text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            title="Minimize"
            aria-label="Minimize window"
          >
            <Minus className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            onClick={() => windowAction("toggleMaximize")}
            className="h-full w-11 flex items-center justify-center text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            title={maximized ? "Restore" : "Maximize"}
            aria-label={maximized ? "Restore window" : "Maximize window"}
          >
            <Square className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            onClick={() => windowAction("close")}
            className="h-full w-11 flex items-center justify-center text-muted-foreground hover:bg-red-500/80 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            title="Close"
            aria-label="Close window"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
