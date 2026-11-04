import { useEffect, useMemo, useRef, useState } from "react";
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
import { connectionMatches, tokenize } from "@/lib/search";
import { forwardEndpoint, isForwardConnection } from "@/lib/sshTerms";
import { useListboxNavigation } from "@/hooks/useListboxNavigation";

interface ConnectPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connections: Connection[];
  credentials: Credential[];
  onConnect: (connection: Connection) => void;
}

function endpointSubtitle(conn: Connection): string {
  if (isForwardConnection(conn)) {
    return forwardEndpoint(conn);
  }
  if (conn.type === "jump_shell") {
    return `${conn.destination_host}:${conn.destination_port} via ${conn.gateway_host}`;
  }
  return `${conn.host}:${conn.port}`;
}

/** Its own component so that a closed picker builds no rows on each App render. */
function PickerRows({
  connections,
  credentials,
  activeIndex,
  rowProps,
  onChoose,
}: {
  connections: Connection[];
  credentials: Credential[];
  activeIndex: number;
  rowProps: ReturnType<typeof useListboxNavigation>["rowProps"];
  onChoose: (connection: Connection) => void;
}) {
  const names = useMemo(() => new Map(credentials.map((c) => [c.id, c.name])), [credentials]);
  return connections.map((conn, idx) => {
    const color = getColorHex(conn.color);
    const isActive = idx === activeIndex;
    const credentialName = conn.credential_id ? names.get(conn.credential_id) : undefined;
    return (
      <div
        {...rowProps(idx)}
        key={conn.id}
        id={`connect-picker-row-${idx}`}
        data-name={conn.name}
        role="option"
        aria-selected={isActive}
        onClick={() => onChoose(conn)}
        className={cn(
          "flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors",
          isActive ? "bg-accent" : "hover:bg-accent/60",
        )}
        style={color ? { borderLeft: `3px solid ${color}` } : undefined}
      >
        {conn.type !== "direct" ? (
          <Network className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
        ) : (
          <Server className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{conn.name}</p>
          <p className="text-xs text-muted-foreground truncate">
            {endpointSubtitle(conn)}
            {credentialName && <span className="ml-1">· {credentialName}</span>}
          </p>
        </div>
      </div>
    );
  });
}

export function ConnectPicker({
  open,
  onOpenChange,
  connections,
  credentials,
  onConnect,
}: ConnectPickerProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const tokens = useMemo(() => tokenize(query), [query]);

  const filtered = useMemo(
    () => connections.filter((c) => connectionMatches(c, tokens)),
    [connections, tokens],
  );

  const choose = (conn: Connection | undefined) => {
    if (!conn) return;
    onConnect(conn);
    onOpenChange(false);
  };

  const { activeIndex, setActiveIndex, onKeyDown, listProps, rowProps } = useListboxNavigation({
    count: filtered.length,
    onChoose: (index) => choose(filtered[index]),
  });

  // Reset query/selection whenever the picker is reopened.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open, setActiveIndex]);

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
      <DialogContent kind="palette" className="sm:max-w-[480px] p-0 gap-0">
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
            data-testid="connect-picker-input"
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
            {...listProps}
            id={listboxId}
            role="listbox"
            aria-label="Matching connections"
            className="max-h-[320px] overflow-y-auto py-1"
          >
            <PickerRows
              connections={filtered}
              credentials={credentials}
              activeIndex={activeIndex}
              rowProps={rowProps}
              onChoose={choose}
            />
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
