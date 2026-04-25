import React, { useEffect, useMemo, useRef, useState } from "react";
import { Connection, Credential } from "@/types";
import { Search, Server, Network } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { cn } from "@/lib/utils";
import { getColorHex } from "@/lib/colors";

interface ConnectPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connections: Connection[];
  credentials: Credential[];
  onConnect: (connection: Connection) => void;
}

function endpointSubtitle(conn: Connection): string {
  if (conn.type === "port_forward") {
    return `127.0.0.1:${conn.local_port} → ${conn.destination_host}:${conn.destination_port}`;
  }
  if (conn.type === "jump_shell") {
    return `${conn.destination_host}:${conn.destination_port} via ${conn.gateway_host}`;
  }
  return `${conn.host}:${conn.port}`;
}

function matches(conn: Connection, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  // Audit-4 Phase 4b: only port_forward/jump_shell carry destination/gateway
  // hosts; for direct connections the relevant search fields are name/host.
  const haystack = [
    conn.name,
    conn.host,
    conn.type !== "direct" ? conn.destination_host : undefined,
    conn.type !== "direct" ? conn.gateway_host : undefined,
    ...(conn.tags ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

export function ConnectPicker({
  open,
  onOpenChange,
  connections,
  credentials,
  onConnect,
}: ConnectPickerProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /*
    Audit-3 P2#11: hover/keyboard race.

    Previous implementation set `onMouseEnter={() => setActiveIndex(idx)}`
    on every row. That looks fine in isolation, but the active-row
    `scrollIntoView` effect (which runs on every ArrowUp/Down) moves
    a *different* row under a stationary cursor. The browser then
    fires synthetic `mouseenter` events for whichever rows passed
    under the cursor during the scroll — which clobbers the
    keyboard's selection and "snaps back" the highlight to whatever
    row happens to be under the pointer. Net effect: pressing
    ArrowDown twice quickly sometimes only moves once, and the user
    can never reach the bottom of a long list with the keyboard.

    Standard fix: gate hover on actual pointer motion. We track a
    `pointerMovedRef` that flips true on `pointermove` and false on
    every keystroke. `onPointerEnter` only changes the selection
    when the pointer genuinely moved (i.e. the user is hovering by
    intent, not because the list scrolled under them).
  */
  const pointerMovedRef = useRef(false);

  const getCredentialName = (credId?: string) => {
    if (!credId) return null;
    return credentials.find((c) => c.id === credId)?.name ?? null;
  };

  const tokens = useMemo(
    () =>
      query
        .toLowerCase()
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean),
    [query],
  );

  const filtered = useMemo(
    () => connections.filter((c) => matches(c, tokens)),
    [connections, tokens],
  );

  // Reset query/selection whenever the picker is reopened.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  // Clamp activeIndex when the filtered list shrinks.
  useEffect(() => {
    if (activeIndex >= filtered.length) {
      setActiveIndex(filtered.length === 0 ? 0 : filtered.length - 1);
    }
  }, [filtered.length, activeIndex]);

  // Keep the active row scrolled into view.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`,
    );
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, filtered.length]);

  const choose = (conn: Connection | undefined) => {
    if (!conn) return;
    onConnect(conn);
    onOpenChange(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      pointerMovedRef.current = false;
      setActiveIndex((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      pointerMovedRef.current = false;
      setActiveIndex((i) =>
        filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length,
      );
    } else if (e.key === "Home") {
      e.preventDefault();
      pointerMovedRef.current = false;
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      pointerMovedRef.current = false;
      if (filtered.length > 0) setActiveIndex(filtered.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(filtered[activeIndex]);
    }
  };

  const listboxId = "connect-picker-list";
  const activeId =
    filtered.length > 0 ? `connect-picker-row-${activeIndex}` : undefined;
  // P2-A8: WAI-ARIA 1.2 combobox pattern. The listbox is "expanded"
  // whenever the picker has results to show — when there are no
  // matches we still render a status message but no listbox exists,
  // so aria-expanded is false to match what's actually in the DOM.
  const expanded = filtered.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px] p-0 gap-0">
        <DialogHeader className="sr-only">
          <DialogTitle>Open Connection</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search
            className="h-4 w-4 text-muted-foreground shrink-0"
            aria-hidden="true"
          />
          {/*
            Audit-3 follow-up P2#4: switched from a bare <input> to
            the shared <Input> primitive so this combobox inherits
            the focus-visible ring + theme tokens. The picker shell
            owns the border (border-b on the parent), so we strip
            the primitive's own border/bg/height/padding via class
            overrides while keeping the focus-visible ring.
          */}
          <Input
            ref={inputRef}
            type="search"
            // Autofocus is intentional: the picker is invoked via Cmd+K /
            // the + tab button as a "go now" affordance.
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search connections by name, host, or tag…"
            aria-label="Search connections"
            role="combobox"
            aria-expanded={expanded}
            aria-autocomplete="list"
            aria-controls={expanded ? listboxId : undefined}
            aria-activedescendant={activeId}
            className="flex-1 h-auto border-0 bg-transparent px-0 py-0 ring-offset-0 focus-visible:ring-2 focus-visible:ring-offset-0"
          />
        </div>
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No connections configured yet.
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No matches for “{query}”.
          </p>
        ) : (
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label="Matching connections"
            onPointerMove={() => {
              pointerMovedRef.current = true;
            }}
            className="max-h-[320px] overflow-y-auto py-1"
          >
            {filtered.map((conn, idx) => {
              const color = getColorHex(conn.color);
              const isActive = idx === activeIndex;
              return (
                <div
                  key={conn.id}
                  id={`connect-picker-row-${idx}`}
                  data-index={idx}
                  data-name={conn.name}
                  role="option"
                  aria-selected={isActive}
                  onPointerEnter={() => {
                    // Only follow the pointer if it actually moved
                    // (vs. the row sliding under a stationary cursor
                    // because of keyboard-driven scrollIntoView).
                    if (pointerMovedRef.current) setActiveIndex(idx);
                  }}
                  onClick={() => choose(conn)}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors",
                    isActive ? "bg-accent" : "hover:bg-accent/60",
                  )}
                  style={
                    color ? { borderLeft: `3px solid ${color}` } : undefined
                  }
                >
                  {conn.type !== "direct" ? (
                    <Network
                      className="h-4 w-4 text-muted-foreground shrink-0"
                      aria-hidden="true"
                    />
                  ) : (
                    <Server
                      className="h-4 w-4 text-muted-foreground shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{conn.name}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {endpointSubtitle(conn)}
                      {getCredentialName(conn.credential_id) && (
                        <span className="ml-1">
                          · {getCredentialName(conn.credential_id)}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground flex items-center gap-3">
          <span>
            <kbd className="px-1 py-0.5 rounded bg-muted">↑</kbd>
            <kbd className="px-1 py-0.5 rounded bg-muted ml-0.5">↓</kbd> navigate
          </span>
          <span>
            <kbd className="px-1 py-0.5 rounded bg-muted">↵</kbd> connect
          </span>
          <span>
            <kbd className="px-1 py-0.5 rounded bg-muted">Esc</kbd> close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
