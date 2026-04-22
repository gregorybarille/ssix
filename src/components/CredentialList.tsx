import React, { useState } from "react";
import { Credential } from "@/types";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Key, Lock, Edit, Trash2, UploadCloud } from "lucide-react";
import { InstallKeyDialog } from "./InstallKeyDialog";

interface CredentialListProps {
  credentials: Credential[];
  onEdit: (credential: Credential) => void;
  onDelete: (id: string) => void;
}

export function CredentialList({
  credentials,
  onEdit,
  onDelete,
}: CredentialListProps) {
  const [installCred, setInstallCred] = useState<Credential | null>(null);

  if (credentials.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Key className="h-12 w-12 mb-3 opacity-30" />
        <p className="text-sm">No credentials yet</p>
        <p className="text-xs mt-1">Add your first SSH credential</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {credentials.map((cred) => (
        <div
          key={cred.id}
          className="group flex items-center gap-3 rounded-lg p-3 hover:bg-accent transition-colors"
        >
          <div className="flex-shrink-0">
            {cred.type === "ssh_key" ? (
              <Key className="h-5 w-5 text-muted-foreground" />
            ) : (
              <Lock className="h-5 w-5 text-muted-foreground" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm truncate">{cred.name}</span>
              <Badge variant="secondary" className="text-xs shrink-0">
                {cred.type === "ssh_key" ? "SSH Key" : "Password"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground truncate">
              {cred.username}
              {cred.type === "ssh_key" && cred.private_key_path && (
                <span className="ml-2 opacity-70">· {cred.private_key_path}</span>
              )}
              {cred.type === "ssh_key" && cred.private_key && !cred.private_key_path && (
                <span className="ml-2 opacity-70">· inline</span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {cred.type === "ssh_key" && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setInstallCred(cred)}
                title="Install public key on remote host"
              >
                <UploadCloud className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => onEdit(cred)}
              title="Edit credential"
            >
              <Edit className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={() => onDelete(cred.id)}
              title="Delete credential"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ))}
      {installCred && (
        <InstallKeyDialog
          open={!!installCred}
          onOpenChange={(o) => !o && setInstallCred(null)}
          credentialId={installCred.id}
          defaultUsername={installCred.username}
        />
      )}
    </div>
  );
}
