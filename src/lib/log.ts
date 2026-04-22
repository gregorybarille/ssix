import { create } from "zustand";
import { LogEntry } from "@/types";

const MAX = 1000;

interface LogsState {
  entries: LogEntry[];
  push: (entry: LogEntry) => void;
  clear: () => void;
}

export const useFrontendLogs = create<LogsState>((set) => ({
  entries: [],
  push: (entry) =>
    set((s) => {
      const next = s.entries.length >= MAX ? s.entries.slice(1) : s.entries.slice();
      next.push(entry);
      return { entries: next };
    }),
  clear: () => set({ entries: [] }),
}));

function emit(level: LogEntry["level"], source: string, message: string) {
  useFrontendLogs.getState().push({
    ts: Date.now(),
    level,
    source,
    message,
  });
}

export const log = {
  info: (source: string, message: string) => {
    // eslint-disable-next-line no-console
    console.info(`[${source}]`, message);
    emit("info", source, message);
  },
  warn: (source: string, message: string) => {
    // eslint-disable-next-line no-console
    console.warn(`[${source}]`, message);
    emit("warn", source, message);
  },
  error: (source: string, message: string) => {
    // eslint-disable-next-line no-console
    console.error(`[${source}]`, message);
    emit("error", source, message);
  },
};
