import React, { useEffect, useState } from "react";
import { LogEntry } from "@/types";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { invoke } from "@/lib/tauri";
import { useFrontendLogs } from "@/lib/log";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

function levelColor(level: string) {
  switch (level) {
    case "error":
      return "text-destructive";
    case "warn":
      return "text-yellow-500";
    case "info":
      return "text-blue-400";
    default:
      return "text-muted-foreground";
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
          className="grid grid-cols-[90px_60px_100px_1fr] gap-2 px-2 py-0.5 hover:bg-accent/30 rounded"
        >
          <span className="text-muted-foreground-soft">{fmtTs(e.ts)}</span>
          <span className={cn("uppercase font-semibold", levelColor(e.level))}>
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
          <Trash2 className="h-3.5 w-3.5 mr-1" />
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
