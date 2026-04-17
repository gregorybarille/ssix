import React from "react";
import { Connection, Credential } from "@/types";
import { Server, Network } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

interface ConnectPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connections: Connection[];
  credentials: Credential[];
  onConnect: (connection: Connection) => void;
}

export function ConnectPicker({
  open,
  onOpenChange,
  connections,
  credentials,
  onConnect,
}: ConnectPickerProps) {
  const getCredentialName = (credId?: string) => {
    if (!credId) return null;
    return credentials.find((c) => c.id === credId)?.name ?? null;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Open Connection</DialogTitle>
        </DialogHeader>
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No connections configured yet.
          </p>
        ) : (
          <div className="max-h-[300px] overflow-y-auto space-y-1">
            {connections.map((conn) => (
              <button
                key={conn.id}
                className="w-full flex items-center gap-3 rounded-lg p-3 text-left transition-colors hover:bg-accent"
                onClick={() => {
                  onConnect(conn);
                  onOpenChange(false);
                }}
              >
                {conn.type === "tunnel" ? (
                  <Network className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : (
                  <Server className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{conn.name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {conn.host}:{conn.port}
                    {getCredentialName(conn.credential_id) && (
                      <span className="ml-1">· {getCredentialName(conn.credential_id)}</span>
                    )}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
