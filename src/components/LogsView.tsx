import React, { useEffect, useState } from "react";
import { LogEntry } from "@/types";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { invoke } from "@/lib/tauri";
import { useFrontendLogs } from "@/lib/log";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * P2-A2: log levels were previously distinguished only by foreground
 * color (red / yellow / blue / muted). The text label "ERROR" /
 * "WARN" already carried the meaning, but visual prominence relied on
 * color alone, which is a WCAG 1.4.1 (Use of Color) papercut for
 * colorblind users. We now render each level as a bordered badge with
 * a leading glyph; color is supplementary, never the sole channel.
 */
function levelBadgeClass(level: string) {
  switch (level) {
    case "error":
      return "border-destructive/60 bg-destructive/10 text-destructive";
    case "warn":
      return "border-yellow-500/60 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400";
    case "info":
      return "border-blue-500/60 bg-blue-500/10 text-blue-600 dark:text-blue-300";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function levelGlyph(level: string) {
  switch (level) {
    case "error":
      return "\u2715"; // ✕
    case "warn":
      return "\u25B2"; // ▲
    case "info":
      return "\u2139"; // ℹ
    default:
      return "\u00B7"; // ·
  }
}

function fmtTs(ts: number) {
  const d = new Date(ts);
  return d.toISOString().substring(11, 23);
}

function LogList({ entries, empty }: { entries: LogEntry[]; empty: string }) {
  if (entries.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        {empty}
      </div>
    );
  }
  return (
    <div className="font-mono text-xs space-y-0.5 px-2 py-2">
      {entries.map((e, i) => (
        <div
          key={`${e.ts}-${e.source}-${e.message}-${i}`}
          className="grid grid-cols-[90px_72px_100px_1fr] gap-2 px-2 py-0.5 hover:bg-accent/30 rounded items-start"
        >
          <span className="text-muted-foreground-soft">{fmtTs(e.ts)}</span>
          <span
            className={cn(
              "inline-flex items-center justify-center gap-1 rounded border px-1.5 py-0 text-[10px] font-semibold uppercase leading-4",
              levelBadgeClass(e.level),
            )}
          >
            <span aria-hidden="true">{levelGlyph(e.level)}</span>
            {e.level}
          </span>
          <span className="text-muted-foreground truncate">{e.source}</span>
          <span className="break-words whitespace-pre-wrap">{e.message}</span>
        </div>
      ))}
    </div>
  );
}

export function LogsView() {
  const frontend = useFrontendLogs((s) => s.entries);
  const clearFrontend = useFrontendLogs((s) => s.clear);
  const [backend, setBackend] = useState<LogEntry[]>([]);
  const [tab, setTab] = useState<"frontend" | "backend">("backend");

  const refreshBackend = async () => {
    try {
      const list = await invoke<LogEntry[]>("get_logs");
      setBackend(list);
    } catch {
      // ignore — logs facility may not be available in tests
    }
  };

  useEffect(() => {
    refreshBackend();
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<LogEntry>("app-log", (event) => {
          setBackend((prev) => {
            const next = prev.length >= 1000 ? prev.slice(1) : prev.slice();
            next.push(event.payload);
            return next;
          });
        });
      } catch {
        // event API not available in tests
      }
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  const clearBackend = async () => {
    try {
      await invoke("clear_logs");
    } catch {
      // ignore
    }
    setBackend([]);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <h1 className="text-lg font-semibold">Logs</h1>
        <Button
          size="sm"
          variant="outline"
          onClick={tab === "frontend" ? clearFrontend : clearBackend}
        >
          <Trash2 aria-hidden="true" className="h-3.5 w-3.5 mr-1" />
          Clear
        </Button>
      </div>
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as "frontend" | "backend")}
        className="flex-1 flex flex-col min-h-0"
      >
        <TabsList className="mx-6 mt-3 self-start">
          <TabsTrigger value="backend">Backend ({backend.length})</TabsTrigger>
          <TabsTrigger value="frontend">Frontend ({frontend.length})</TabsTrigger>
        </TabsList>
        <TabsContent
          value="backend"
          className="flex-1 overflow-y-auto mt-2"
          forceMount
          hidden={tab !== "backend"}
        >
          <LogList entries={backend} empty="No backend log entries." />
        </TabsContent>
        <TabsContent
          value="frontend"
          className="flex-1 overflow-y-auto mt-2"
          forceMount
          hidden={tab !== "frontend"}
        >
          <LogList entries={frontend} empty="No frontend log entries." />
        </TabsContent>
      </Tabs>
    </div>
  );
}
