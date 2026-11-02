import { memo } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "../ui/button";
import { formatSize } from "@/lib/sftp";
import { useSftpStore, type Transfer } from "@/store/useSftpStore";

function percent(transfer: Transfer): number {
  if (transfer.status === "done") return 100;
  if (transfer.bytesTotal <= 0) return 0;
  return Math.min(100, Math.floor((transfer.bytesDone / transfer.bytesTotal) * 100));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function statusText(transfer: Transfer): string {
  switch (transfer.status) {
    case "running":
      if (transfer.cancelling) return "Cancelling…";
      if (transfer.bytesTotal === 0 && transfer.filesTotal === 0) return "Starting…";
      return `${formatSize(transfer.bytesDone)} of ${formatSize(transfer.bytesTotal)}`;
    case "conflict":
      return "Already exists, waiting for your answer";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return transfer.error ?? "Failed";
    case "done": {
      const copied = `${plural(transfer.filesDone, "file")}, ${formatSize(transfer.bytesDone)}`;
      return transfer.skipped > 0
        ? `${copied}, ${transfer.skipped} skipped (symbolic links and special files)`
        : copied;
    }
  }
}

// Memoized: with thousands of rows, each event only changes one of them.
const TransferRow = memo(function TransferRow({ transfer }: { transfer: Transfer }) {
  const { cancelTransfer, dismissTransfer } = useSftpStore(
    useShallow((s) => ({
      cancelTransfer: s.cancelTransfer,
      dismissTransfer: s.dismissTransfer,
    })),
  );
  const Icon = transfer.input.direction === "upload" ? ArrowUp : ArrowDown;
  const value = percent(transfer);
  return (
    <li
      className="flex items-center gap-2 text-xs"
      data-testid="files-transfer"
      data-name={transfer.name}
      data-status={transfer.status}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-medium">{transfer.name}</span>
          <span
            className={
              transfer.status === "failed"
                ? "text-destructive break-words min-w-0"
                : "text-muted-foreground shrink-0"
            }
            data-testid="files-transfer-status"
          >
            {statusText(transfer)}
          </span>
        </div>
        {transfer.status === "running" && (
          <div
            role="progressbar"
            aria-label={`Copying ${transfer.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={value}
            className="h-1 overflow-hidden rounded bg-muted"
          >
            <div className="h-full bg-primary" style={{ width: `${value}%` }} />
          </div>
        )}
      </div>
      {transfer.status === "running" ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          disabled={transfer.cancelling}
          onClick={() => void cancelTransfer(transfer.id)}
          aria-label={`Cancel copying ${transfer.name}`}
          data-testid="files-transfer-cancel"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      ) : (
        transfer.status !== "conflict" && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={() => dismissTransfer(transfer.id)}
            aria-label={`Dismiss ${transfer.name}`}
            data-testid="files-transfer-dismiss"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        )
      )}
    </li>
  );
});

/** What is being copied, what was, and how each one ended. */
export function TransferList() {
  const transfers = useSftpStore((s) => s.transfers);
  const clearFinished = useSftpStore((s) => s.clearFinished);
  if (transfers.length === 0) return null;
  const anyFinished = transfers.some((t) => t.status !== "running" && t.status !== "conflict");
  return (
    <section
      className="border-t border-border px-6 py-2 max-h-44 overflow-y-auto"
      aria-label="Transfers"
      data-testid="files-transfers"
    >
      <div className="flex items-center justify-between pb-1">
        <h2 className="text-xs font-semibold text-muted-foreground">Transfers</h2>
        {anyFinished && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={clearFinished}
            data-testid="files-transfers-clear"
          >
            Clear finished
          </Button>
        )}
      </div>
      <ul className="space-y-1.5">
        {transfers.map((transfer) => (
          <TransferRow key={transfer.id} transfer={transfer} />
        ))}
      </ul>
    </section>
  );
}
