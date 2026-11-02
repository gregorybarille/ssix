import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { FolderOpen, Unplug } from "lucide-react";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/EmptyState";
import { ErrorBanner } from "../ui/error-banner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { EditPanel } from "../sftp/EditPanel";
import { FileDialogs } from "../sftp/FileDialogs";
import { FilePane } from "../sftp/FilePane";
import { TransferList } from "../sftp/TransferList";
import { dropFolderAt } from "../sftp/useFileDrag";
import { useOsFileDrop } from "../sftp/useOsFileDrop";
import { parseHostKeyMismatch } from "@/lib/hostKey";
import { readableSftpError } from "@/lib/sftp";
import { isForwardConnection } from "@/lib/sshTerms";
import { useConnectionsStore } from "@/store/useConnectionsStore";
import { useSftpStore } from "@/store/useSftpStore";

function ConnectFailure({ error }: { error: string }) {
  const trustHostKey = useSftpStore((s) => s.trustHostKey);
  const retry = useSftpStore((s) => s.retryConnect);
  const mismatch = parseHostKeyMismatch(error);
  if (!mismatch) {
    return (
      <ErrorBanner
        className="mx-6 mt-2"
        message={readableSftpError(error)}
        onRetry={() => void retry()}
        testId="files-connect-error"
      />
    );
  }
  return (
    <ErrorBanner
      className="mx-6 mt-2"
      testId="files-connect-error"
      message={
        <>
          <span className="block font-semibold">
            Host key for {mismatch.host}:{mismatch.port} has changed
          </span>
          <span className="block">{mismatch.message}</span>
          <span className="block font-mono text-xs break-all">{mismatch.fingerprint}</span>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void trustHostKey(mismatch.host, mismatch.port)}
            data-testid="files-trust-host-key"
          >
            Trust new host key
          </Button>
        </>
      }
    />
  );
}

/**
 * The Files tab: this computer on the left and a connection's files on the
 * right, with what is being copied between them underneath. Sessions and
 * transfers live in the store, so they outlast a visit to another tab.
 */
export function FilesView() {
  const {
    connectionId,
    label,
    connected,
    connecting,
    connectError,
    editOpening,
    editError,
    initLocal,
    connect,
    disconnect,
    uploadPaths,
    dismissEditError,
  } = useSftpStore(
    useShallow((s) => ({
      connectionId: s.connectionId,
      label: s.label,
      connected: s.sessionId !== null,
      connecting: s.connecting,
      connectError: s.connectError,
      editOpening: s.editOpening,
      editError: s.editError,
      initLocal: s.initLocal,
      connect: s.connect,
      disconnect: s.disconnect,
      uploadPaths: s.uploadPaths,
      dismissEditError: s.dismissEditError,
    })),
  );
  const connections = useConnectionsStore((s) => s.connections);
  const browsable = useMemo(
    () => connections.filter((c) => !isForwardConnection(c)),
    [connections],
  );

  useEffect(() => {
    void initLocal();
  }, [initLocal]);

  // Files from the desktop can only go up: "local" is what they are not.
  useOsFileDrop((paths, x, y) => {
    const dir = dropFolderAt(x, y, "local");
    if (dir) void uploadPaths(paths, dir);
  });

  const placeholder = connecting ? (
    <EmptyState icon={FolderOpen} title="Connecting…" />
  ) : browsable.length === 0 ? (
    <EmptyState
      icon={FolderOpen}
      title="No connections to browse"
      hint="Add a direct or jump host connection first."
    />
  ) : (
    <EmptyState
      icon={FolderOpen}
      title="No connection open"
      hint="Pick a connection above to see its files."
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-6 py-4">
        <h1 className="text-lg font-semibold">Files</h1>
        <div className="flex-1" />
        <span
          className="truncate text-xs text-muted-foreground"
          role="status"
          data-testid="files-status"
          data-state={connected ? "connected" : connecting ? "connecting" : "idle"}
        >
          {connected ? label : connecting ? "Connecting…" : ""}
        </span>
        <Select value={connectionId ?? ""} onValueChange={(id) => void connect(id)}>
          <SelectTrigger
            size="sm"
            className="w-56"
            aria-label="Connection to browse"
            data-testid="files-connection-select"
          >
            <SelectValue placeholder="Choose a connection" />
          </SelectTrigger>
          <SelectContent>
            {browsable.map((connection) => (
              <SelectItem key={connection.id} value={connection.id} data-name={connection.name}>
                {connection.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          disabled={!connected && !connecting}
          onClick={disconnect}
          aria-label="Disconnect"
          title="Disconnect"
          data-testid="files-disconnect"
        >
          <Unplug className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      {connectError && <ConnectFailure error={connectError} />}
      {editOpening && (
        <p className="mx-6 mt-2 text-xs text-muted-foreground" role="status">
          Downloading a copy to edit…
        </p>
      )}
      {editError && (
        <div className="mx-6 mt-2 space-y-1">
          <ErrorBanner message={editError} testId="files-edit-open-error" />
          <Button variant="ghost" size="sm" onClick={dismissEditError}>
            Dismiss
          </Button>
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 p-3">
        <FilePane side="local" title="This computer" />
        <FilePane side="remote" title={label ?? "Server"} placeholder={placeholder} />
      </div>
      <TransferList />
      <FileDialogs />
      <EditPanel />
    </div>
  );
}
