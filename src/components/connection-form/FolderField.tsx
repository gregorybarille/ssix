import { useMemo } from "react";
import { knownFolderPaths } from "@/lib/folders";
import { useConnectionsStore } from "@/store/useConnectionsStore";
import { FieldError, invalidAria } from "../ConnectionFormFields";
import { FolderPicker } from "../FolderPicker";
import { Label } from "../ui/label";

interface FolderFieldProps {
  value: string;
  onChange: (value: string) => void;
  error?: string;
}

/** The connection's folder in the Folders layout; see `docs/folders.md`. */
export function FolderField({ value, onChange, error }: FolderFieldProps) {
  const connections = useConnectionsStore((s) => s.connections);
  const folders = useMemo(() => knownFolderPaths(connections), [connections]);
  return (
    <div className="space-y-2">
      <Label htmlFor="folder">Folder</Label>
      <FolderPicker
        id="folder"
        placeholder="prod/eu"
        folders={folders}
        value={value}
        onChange={onChange}
        data-testid="connection-form-folder"
        aria-describedby="folder-hint"
        {...invalidAria(error, "folder-error")}
      />
      <FieldError id="folder-error" message={error} testId="connection-form-folder-error" />
      <p id="folder-hint" className="text-xs text-muted-foreground">
        Choose a folder or type a new path; / nests one inside another. Leave it empty for
        no folder.
      </p>
    </div>
  );
}
