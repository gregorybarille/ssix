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
  // Detect platform synchronously in the initial state. If we deferred this
  // to a useEffect the maximize-subscription effect below would run once
  // with platform === "macos", hit the early return, and never subscribe to
  // onResized on Windows/Linux until something else triggered a re-render.
  const [platform] = useState<Platform>(() => detectPlatform());
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (platform === "macos") return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    // Import the window module once per effect run and reuse it across
    // the initial query and the subscription. Using a single import keeps
    // the code clearer and avoids two separate dynamic-import overheads.
    const run = async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const w = getCurrentWindow();

        const refresh = async () => {
          try {
            const isMax = await w.isMaximized();
            if (!cancelled) setMaximized(isMax);
          } catch {
            /* swallow */
          }
        };

        // Initial state.
        await refresh();
        if (cancelled) return;

        // Subscribe to OS resize events. The maximize/restore icon and
        // aria-label are driven by the subscription so the OS — not
        // optimistic local state — is the source of truth. This catches
        // double-click on the title bar, OS-level shortcuts (F11 /
        // Win+Up), and window-snapping behaviour that bypasses our
        // toggleMaximize handler.
        unlisten = await w.onResized(() => {
          // The resize payload only carries size; re-query the flag.
          refresh();
        });
      } catch {
        /* not running under Tauri (jsdom, future web build, etc.) */
      }
    };

    run();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [platform]);

  const windowAction = async (action: "minimize" | "toggleMaximize" | "close") => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      if (action === "minimize") await win.minimize();
      else if (action === "toggleMaximize") {
        await win.toggleMaximize();
        // The onResized subscription will catch up on its own, but call
        // refresh inline too so the icon updates immediately even on
        // platforms that batch resize events.
        try {
          setMaximized(await win.isMaximized());
        } catch {
          /* swallow */
        }
      } else await win.close();
    } catch {}
  };

  return (
    <div
      data-tauri-drag-region
      className="relative h-9 bg-card border-b border-border flex items-center select-none shrink-0"
    >
      {/* macOS: left spacer for traffic lights */}
      {platform === "macos" && <div className="w-20" data-tauri-drag-region />}

      {/* Draggable fill area */}
      <div className="flex-1" data-tauri-drag-region />

      {/*
        Centered lowercase wordmark. Absolutely positioned so it sits
        in the geometric center of the title bar regardless of which
        platform-specific affordances flank it (macOS traffic lights
        on the left, Windows/Linux window controls on the right).
        `pointer-events-none` keeps the entire bar draggable through
        the wordmark — Tauri's drag-region only listens for primary
        clicks on elements that don't intercept them.
      */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground tracking-tight"
      >
        ssix
      </span>

      <button
        onClick={onSettings}
        title="Settings"
        aria-label="Settings"
        aria-pressed={settingsActive}
        data-testid="nav-settings"
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
            aria-label="Minimize window"
          >
            <Minus className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            onClick={() => windowAction("toggleMaximize")}
            className="h-full w-11 flex items-center justify-center text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            aria-label={maximized ? "Restore window" : "Maximize window"}
          >
            <Square className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            onClick={() => windowAction("close")}
            className="h-full w-11 flex items-center justify-center text-muted-foreground hover:bg-red-500/80 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            aria-label="Close window"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
